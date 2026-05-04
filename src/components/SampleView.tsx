import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import type { Sample, Song } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { workbenches } from "../state/sampleWorkbench";
import { transport } from "../state/song";
import {
  EFFECT_LABELS,
  SOURCE_KINDS,
  SOURCE_LABELS,
  type EffectKind,
  type EffectNode,
  type MonoMix,
  type SampleSource,
  type SampleWorkbench,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import type { ChiptuneParams } from "../core/audio/chiptune";
import { truncateSampleAtLoopEnd } from "../core/audio/loopTruncate";
import { Waveform, type SampleSelection } from "./Waveform";
import { PipelineEditor } from "./PipelineEditor";
import { ChiptuneEditor } from "./ChiptuneEditor";
import { Slider } from "./Slider";

export type { SampleSelection };

/**
 * Effect kinds that ride the Crop/Cut row as their own buttons. Order
 * matches the on-screen layout: range-aware first (with Crop/Cut leading,
 * since those are only meaningful with a selection), then range-unaware.
 */
const EFFECT_BUTTON_KINDS: readonly EffectKind[] = [
  "reverse",
  "fadeIn",
  "fadeOut",
  "gain",
  "normalize",
  "filter",
  "crossfade",
] as const;

/** Hover hint that hints at selection-aware vs always-whole behaviour. */
function titleForEffectButton(kind: EffectKind, hasSelection: boolean): string {
  const isRangeAware =
    kind === "reverse" || kind === "fadeIn" || kind === "fadeOut";
  const label = EFFECT_LABELS[kind];
  if (!isRangeAware) return `Append ${label} to the effect chain`;
  return hasSelection
    ? `Append ${label} over the current selection`
    : `Append ${label} (whole sample — no selection)`;
}

const PT_FINETUNE_MIN = -8;
const PT_FINETUNE_MAX = 7;
const PT_VOLUME_MAX = 64;
const SAMPLE_NAME_MAX = 22;

/**
 * PT stores finetune as an unsigned nibble (0..15) where 0..7 are +0..+7 and
 * 8..15 are -8..-1. The UI works in signed values; these helpers bridge.
 */
function signedFinetune(stored: number): number {
  return stored < 8 ? stored : stored - 16;
}
function encodeFinetune(signed: number): number {
  const c = Math.max(PT_FINETUNE_MIN, Math.min(PT_FINETUNE_MAX, signed));
  return c < 0 ? c + 16 : c;
}

interface Props {
  song: Song;
  /** Bytes of a `.wav` file picked by the user, plus the original file name. */
  onLoadWav: (bytes: Uint8Array, filename: string) => void;
  onClear: () => void;
  /** Copy the current sample (data + workbench) to the next empty slot. */
  onDuplicate: () => void;
  /** True iff there is a free slot after the current one. */
  canDuplicate: boolean;
  onPatch: (patch: Partial<Sample>) => void;
  /** Replace sample.data with the [startByte, endByte) slice; loop translates accordingly. */
  onCropToSelection: (startByte: number, endByte: number) => void;
  /** Replace sample.data with everything OUTSIDE [startByte, endByte). */
  onDeleteSelection: (startByte: number, endByte: number) => void;
  /**
   * Append an effect to the workbench chain. For range-aware kinds the
   * caller can use the user's current waveform selection (passed through)
   * to scope the effect to a region; passing `null` defaults the effect to
   * a sensible whole-sample range. Workbench-only — no-ops without one.
   */
  onAddEffect: (kind: EffectKind, selection: SampleSelection | null) => void;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  /**
   * Burn the workbench's effect chain into its source: replace the source
   * WAV with the chain output and clear the chain. PT params are preserved
   * so playback is unchanged. Lets a heavy crop discard its pre-crop frames
   * and shrinks the project file accordingly.
   */
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
  /** Switch the source kind. Creates a default workbench if needed. */
  onSetSourceKind: (kind: SourceKind) => void;
  /** Patch the chiptune source params on the current slot. No-op for sampler. */
  onUpdateChiptune: (patch: Partial<ChiptuneParams>) => void;
  /** Freeze the current chiptune render as a sampler workbench source. */
  onConvertChiptuneToSampler: () => void;
}

/** Editor for the sample under `currentSample()`: waveform + metadata + load. */
export const SampleView: Component<Props> = (props) => {
  const sample = createMemo(
    () => props.song.samples[currentSample() - 1] ?? null,
  );
  const slotIndex = createMemo(() => String(currentSample()).padStart(2, "0"));
  const isLooping = createMemo(() => (sample()?.loopLengthWords ?? 0) > 1);
  // Length the user actually hears: the live worklet plays a snapshot
  // truncated at loopEnd (see core/audio/loopTruncate.ts), so a 32-byte
  // sample with loopEnd at byte 16 exports as 16 bytes. We show that
  // exported length here — the full post-pipeline int8 stays available on
  // the waveform, so dragging the loop end back outward grows this number
  // again. `truncateSampleAtLoopEnd` is also what `engine.load` uses, so
  // the displayed number always matches what playback receives.
  const exportedLengthWords = createMemo(() => {
    const s = sample();
    if (!s) return 0;
    return truncateSampleAtLoopEnd(s).lengthWords;
  });
  // Subscribing to the map signal makes the pipeline section reactive — Solid
  // doesn't deeply track Map mutations, so we read .get() inside the memo.
  const workbench = createMemo<SampleWorkbench | null>(
    () => workbenches().get(currentSample() - 1) ?? null,
  );

  // Sample-meta edits go through `commitEdit`, which is gated on
  // `transport !== 'playing'` to keep the on-screen song in sync with what
  // the worklet is actually rendering. We mirror that gate visually here
  // so the user sees exactly why a click had no effect — without this,
  // toggling Loop mid-playback would briefly flicker checked before Solid
  // reactively reverted it, and the song would silently miss the edit
  // (which exactly matches the "loop works in preview but not in song
  // play" report — the user toggled while playing).
  const editingDisabled = createMemo(() => transport() === "playing");

  // Drag-selection state. Lives at SampleView level because both the Waveform
  // (which draws the overlay and handles the drag) and the action buttons
  // below it (Crop / Cut) need access. Selection is in BYTE indices over
  // the int8 sample data, half-open [start, end).
  const [selection, setSelection] = createSignal<SampleSelection | null>(null);
  // A selection only makes sense for the slot the user drew it on; switching
  // slots discards it.
  createEffect(() => {
    currentSample();
    setSelection(null);
  });

  const onPickWav = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // re-allow picking the same file
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    props.onLoadWav(buf, file.name);
  };

  // Active source kind for the picker. Defaults to 'sampler' when no
  // workbench exists for the slot (the slot may still hold int8 from a
  // .mod load — picking Chiptune kicks off a fresh synth workbench).
  const activeSourceKind = createMemo<SourceKind>(
    () => workbench()?.source.kind ?? "sampler",
  );

  // The hidden file input — clicked by the visible Load WAV button. Always
  // in the DOM so it's reachable regardless of which source kind is active.
  let wavInput: HTMLInputElement | undefined;

  return (
    <div class="sampleview">
      <header class="sampleview__header">
        <h2>Sample {slotIndex()}</h2>
        <div class="source-picker" role="tablist" aria-label="Sample source">
          {SOURCE_KINDS.map((k) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeSourceKind() === k}
              classList={{ "is-active": activeSourceKind() === k }}
              disabled={editingDisabled()}
              title={`Use the ${SOURCE_LABELS[k]} source for this slot`}
              onClick={() => props.onSetSourceKind(k)}
            >
              {SOURCE_LABELS[k]}
            </button>
          ))}
        </div>
        <div class="sampleview__actions">
          <input
            ref={(el) => (wavInput = el)}
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            hidden
            onChange={onPickWav}
          />
          <Show when={activeSourceKind() === "sampler"}>
            <button
              type="button"
              class="file-button"
              title="Load a WAV file into this sample slot"
              onClick={() => wavInput?.click()}
            >
              Load WAV…
            </button>
          </Show>
          <button
            type="button"
            onClick={props.onDuplicate}
            disabled={
              !sample() ||
              sample()!.lengthWords === 0 ||
              !props.canDuplicate ||
              editingDisabled()
            }
            title={
              !sample() || sample()!.lengthWords === 0
                ? "Nothing to duplicate"
                : !props.canDuplicate
                  ? "No empty sample slot after this one"
                  : "Copy this sample (and its workbench) into the next empty slot"
            }
          >
            Duplicate sample
          </button>
          <button
            type="button"
            onClick={props.onClear}
            disabled={!sample() || sample()!.lengthWords === 0}
          >
            Clear sample
          </button>
        </div>
      </header>

      <Show
        when={sample()}
        fallback={
          <p class="placeholder">Select a sample slot from the list.</p>
        }
      >
        {/* Sample-meta row sits above the waveform so the user's eye lands
            on the editable fields (Name / Length / Volume / Finetune /
            Loop) before the visual area below — matches how the rest of
            the app reads top-down. */}
        <div class="samplemeta">
          <label>
            <span class="samplemeta__label">Name</span>
            <input
              type="text"
              maxLength={SAMPLE_NAME_MAX}
              value={sample()!.name}
              placeholder="(unnamed)"
              disabled={editingDisabled()}
              onInput={(e) => props.onPatch({ name: e.currentTarget.value })}
            />
          </label>
          <label>
            <span class="samplemeta__label">Length</span>
            <span class="samplemeta__static">
              {exportedLengthWords() * 2} bytes ({exportedLengthWords()} words)
            </span>
          </label>
          <Slider
            label={`Volume (0–${PT_VOLUME_MAX})`}
            min={0}
            max={PT_VOLUME_MAX}
            step={1}
            value={sample()!.volume}
            disabled={editingDisabled()}
            snap={(v) => Math.max(0, Math.min(PT_VOLUME_MAX, Math.round(v)))}
            format={(v) => `${Math.round(v)}`}
            onInput={(v) => props.onPatch({ volume: v })}
          />
          <Slider
            label={`Finetune (${PT_FINETUNE_MIN} to +${PT_FINETUNE_MAX})`}
            min={PT_FINETUNE_MIN}
            max={PT_FINETUNE_MAX}
            step={1}
            value={signedFinetune(sample()!.finetune)}
            disabled={editingDisabled()}
            snap={(v) =>
              Math.max(PT_FINETUNE_MIN, Math.min(PT_FINETUNE_MAX, Math.round(v)))
            }
            format={(v) => {
              const n = Math.round(v);
              return n > 0 ? `+${n}` : `${n}`;
            }}
            onInput={(v) => props.onPatch({ finetune: encodeFinetune(v) })}
          />
          {/* Chiptune samples are loops by design — the synth produces a
              single cycle that `writeWorkbenchToSongPure` keeps fully
              looped on every re-run. Hide the toggle so the user can't
              fight the engine. */}
          <Show when={workbench()?.source.kind !== "chiptune"}>
            <label class="samplemeta__toggle">
              <input
                type="checkbox"
                checked={isLooping()}
                disabled={sample()!.lengthWords === 0 || editingDisabled()}
                onChange={(e) => {
                  if (e.currentTarget.checked) {
                    // If the user has drawn a selection, adopt it as the loop
                    // range and drop the selection — the loop handles take
                    // over the same role visually. Round inward to word
                    // boundaries (PT's loop fields are word-aligned).
                    const sel = selection();
                    if (sel) {
                      const start = (sel.start + 1) & ~1;
                      const end = sel.end & ~1;
                      if (end - start >= 2) {
                        props.onPatch({
                          loopStartWords: start >> 1,
                          loopLengthWords: (end - start) >> 1,
                        });
                        setSelection(null);
                        return;
                      }
                    }
                    // No (usable) selection — default loop = whole sample.
                    props.onPatch({
                      loopStartWords: 0,
                      loopLengthWords: sample()!.lengthWords,
                    });
                  } else {
                    // PT no-loop sentinel.
                    props.onPatch({ loopLengthWords: 1 });
                  }
                }}
              />
              <span>Loop</span>
            </label>
          </Show>
        </div>
        <Waveform
          sample={sample()!}
          onPatch={props.onPatch}
          selection={selection()}
          onSelect={setSelection}
          // Chiptune samples are always fully looped — the synth re-renders
          // the cycle on every param edit, so the user can't move the
          // boundaries anyway. Hide the overlay and disable handle drag.
          showLoop={workbench()?.source.kind !== "chiptune"}
        />
        {/* Selection-action row: Crop/Cut act on the selection (and require
            one); the remaining effect buttons append to the workbench chain
            — range-aware kinds adopt the selection if present, gain /
            normalize ignore it. All workbench-only buttons disable when the
            slot has no workbench (e.g. a sample loaded from a `.mod`).

            Hidden in chiptune mode: the synth's output is one cycle that's
            re-rendered from params on every edit, so destructive ops (crop /
            cut) and chain effects (reverse / gain / normalize / …) would
            either be wiped on the next param change or just confuse the
            mental model. Edit the synth params instead. */}
        <Show when={workbench()?.source.kind !== "chiptune"}>
          <div class="sampleview__selection">
            <button
              type="button"
              onClick={() => {
                const sel = selection();
                if (!sel) return;
                props.onCropToSelection(sel.start, sel.end);
                setSelection(null);
              }}
              disabled={
                !selection() || selection()!.end - selection()!.start < 2
              }
              title="Keep the selected range, discard the rest"
            >
              Crop
            </button>
            <button
              type="button"
              onClick={() => {
                const sel = selection();
                if (!sel) return;
                props.onDeleteSelection(sel.start, sel.end);
                setSelection(null);
              }}
              disabled={
                !selection() || selection()!.end - selection()!.start < 2
              }
              title="Remove the selected range, keep the rest"
            >
              Delete
            </button>
            <For each={EFFECT_BUTTON_KINDS}>
              {(kind) => {
                // Crossfade is a loop-fix: it only makes sense when the slot
                // already has a real loop (PT's no-loop sentinel is
                // loopLengthWords === 1). Disable the button outside that
                // state so the user can't append a chain entry that would
                // silently no-op.
                const loopActive = () => (sample()?.loopLengthWords ?? 0) > 1;
                const requiresLoop = kind === "crossfade";
                return (
                  <button
                    type="button"
                    onClick={() => {
                      // For range-aware kinds (reverse / fadeIn / fadeOut) the
                      // selection scopes the effect; pass it through whether or
                      // not it's present and let the App handler decide. Don't
                      // clear the selection — unlike Crop/Cut these don't change
                      // the data shape, so the user may want to apply more than
                      // one effect to the same region.
                      props.onAddEffect(kind, selection());
                    }}
                    // Also gate on `lengthWords === 0` so the empty-Sampler
                    // state (just-toggled-from-Chiptune with no WAV loaded)
                    // doesn't let the user append effects to a 0-byte source.
                    disabled={
                      !workbench() ||
                      editingDisabled() ||
                      (sample()?.lengthWords ?? 0) === 0 ||
                      (requiresLoop && !loopActive())
                    }
                    title={
                      requiresLoop && !loopActive()
                        ? "Enable looping first — Crossfade smooths the loop join"
                        : titleForEffectButton(kind, selection() !== null)
                    }
                  >
                    {EFFECT_LABELS[kind]}
                  </button>
                );
              }}
            </For>
            <Show when={selection()}>
              <span class="sampleview__selection-info">
                Selection: bytes {selection()!.start} – {selection()!.end} (
                {selection()!.end - selection()!.start} bytes)
              </span>
            </Show>
          </div>
        </Show>
        <Show
          when={
            workbench()?.source.kind === "chiptune" ? workbench()!.source : null
          }
        >
          {(src) => (
            <ChiptuneEditor
              params={
                (src() as Extract<SampleSource, { kind: "chiptune" }>).params
              }
              disabled={editingDisabled()}
              onUpdate={props.onUpdateChiptune}
              onConvertToSampler={props.onConvertChiptuneToSampler}
            />
          )}
        </Show>
        {/* Pipeline editor is the chain + PT transformer panel. Useful only
            for sampler workbenches — the chiptune source has its own editor
            above and its `pt` is fixed (mono, no resampling), so showing
            the pipeline here would just be visual noise. */}
        <Show when={workbench() && workbench()!.source.kind !== "chiptune"}>
          <PipelineEditor
            wb={workbench()!}
            onRemoveEffect={props.onRemoveEffect}
            onMoveEffect={props.onMoveEffect}
            onPatchEffect={props.onPatchEffect}
            onApplyChain={props.onApplyChain}
            onSetMonoMix={props.onSetMonoMix}
            onSetTargetNote={props.onSetTargetNote}
          />
        </Show>
      </Show>
    </div>
  );
};
