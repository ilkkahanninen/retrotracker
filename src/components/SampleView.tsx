import { For, Show, createEffect, createMemo, type Component } from "solid-js";
import type { Sample, Song } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { workbenches } from "../state/sampleWorkbench";
import { getStashedLoop, stashLoop } from "../state/loopStash";
import { getImportedStash } from "../state/importedStash";
import {
  defaultParamForKind,
  selectedEffectIndex,
  selectedEffectParam,
  setSelectedEffectIndex,
  setSelectedEffectParam,
} from "../state/selectedEffect";
import {
  EFFECT_LABELS,
  PARAM_AXES,
  SOURCE_KINDS,
  SOURCE_LABELS,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
  type MonoMix,
  type ResampleMode,
  type SampleSource,
  type SampleWorkbench,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import type { ChiptuneParams } from "../core/audio/chiptune";
import { truncateSampleAtLoopEnd } from "../core/audio/loopTruncate";
import { Waveform, type WaveformEnvelopeOverlay } from "./Waveform";
import { materializeSource, runChain } from "../core/audio/sampleWorkbench";
import {
  sampleSelection as selection,
  setSampleSelection as setSelection,
  type SampleSelection,
} from "../state/sampleSelection";
import { PipelineEditor } from "./PipelineEditor";
import { ChiptuneEditor } from "./ChiptuneEditor";
import { Slider } from "./Slider";

export type { SampleSelection };

/**
 * Effect kinds that ride the Crop/Cut row as their own buttons. Order
 * matches the on-screen layout: range-aware first (Crop / Cut / Reverse
 * lead since those are only meaningful with a selection), then
 * range-unaware. `volume` is a piecewise-linear amplitude envelope that
 * subsumed the old gain / fadeIn / fadeOut buttons.
 */
const EFFECT_BUTTON_KINDS: readonly EffectKind[] = [
  "reverse",
  "volume",
  "pitch",
  "normalize",
  "filter",
  "shaper",
  "crossfade",
] as const;

/** Hover hint that hints at selection-aware vs always-whole behaviour. */
function titleForEffectButton(kind: EffectKind, hasSelection: boolean): string {
  const isRangeAware = kind === "reverse";
  const label = EFFECT_LABELS[kind];
  if (kind === "volume") {
    return "Append a Volume envelope (double-click on the waveform to add points)";
  }
  if (kind === "pitch") {
    return "Append a Pitch / playback-speed envelope — values >1 speed up (and shorten) the sample, <1 slow down (and stretch)";
  }
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
  /** Append a point to the envelope addressed by `(chainIndex, param)`. */
  onAddEnvelopePoint: (
    chainIndex: number,
    param: EnvelopeParamKey,
    point: EnvelopePoint,
  ) => void;
  /** Remove point `pointIndex` from the envelope addressed by
   *  `(chainIndex, param)`. No-op when only the minimum 2 points remain. */
  onRemoveEnvelopePoint: (
    chainIndex: number,
    param: EnvelopeParamKey,
    pointIndex: number,
  ) => void;
  /** Patch one point's frame / value on the addressed envelope. */
  onPatchEnvelopePoint: (
    chainIndex: number,
    param: EnvelopeParamKey,
    pointIndex: number,
    next: Partial<EnvelopePoint>,
  ) => void;
  /** Shift both endpoints of segment `leftPointIndex..leftPointIndex+1`
   *  on the addressed envelope by `deltaValue`. Used by the segment-drag
   *  interaction. */
  onNudgeEnvelopeSegment: (
    chainIndex: number,
    param: EnvelopeParamKey,
    leftPointIndex: number,
    deltaValue: number,
  ) => void;
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
  /**
   * Copy the [startByte, endByte) slice of the slot's int8 data to the
   * sample clipboard. Falls back to the whole sample if the caller
   * passes the full byte range.
   */
  onCopySelection: (startByte: number, endByte: number) => void;
  /**
   * Cut: copy the [startByte, endByte) bytes to the sample clipboard,
   * then remove them from the slot (workbench: append a `cut` effect;
   * no-workbench: direct int8 mutation).
   */
  onCutSelection: (startByte: number, endByte: number) => void;
  /** Replace the slot's int8 data with the sample clipboard contents. */
  onPasteSampleClipboard: () => void;
  /** Whether the sample clipboard has any bytes to paste — drives the Paste button's enabled state. */
  sampleClipboardHasData: boolean;
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
  /** Toggle a chain entry's bypass (effect short-circuits to pass-through
   *  but its params stay intact for easy A/B). */
  onSetEffectBypass: (index: number, bypassed: boolean) => void;
  /**
   * Burn the workbench's effect chain into its source: replace the source
   * WAV with the chain output and clear the chain. PT params are preserved
   * so playback is unchanged. Lets a heavy crop discard its pre-crop frames
   * and shrinks the project file accordingly.
   */
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
  onSetResampleMode: (mode: ResampleMode) => void;
  onSetDither: (dither: boolean) => void;
  /** Switch the source kind. Creates a default workbench if needed. */
  onSetSourceKind: (kind: SourceKind) => void;
  /** Patch the chiptune source params on the current slot. No-op for sampler. */
  onUpdateChiptune: (patch: Partial<ChiptuneParams>) => void;
  /** Freeze the current chiptune render as a sampler workbench source. */
  onConvertChiptuneToSampler: () => void;
  /**
   * Wrap the slot's existing int8 sample as a fresh sampler workbench so
   * the chain UI becomes available. Visible only when the slot has data
   * but no workbench yet — typical after loading a `.mod`.
   */
  onConvertToSampler: () => void;
}

/** Editor for the sample under `currentSample()`: waveform + metadata + load. */
export const SampleView: Component<Props> = (props) => {
  const sample = createMemo(
    () => props.song.samples[currentSample() - 1] ?? null,
  );
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

  // Envelope overlay payload for the Waveform. Active only when the
  // user has selected a chain entry that owns the active param's
  // envelope (volume → "volume", filter → "cutoff" or "q", shaper →
  // "amount") on a sampler workbench. Computes the chain-stage input
  // length so the overlay caps the X axis at the last valid frame, and
  // so it can convert frames → bytes for rendering against the int8
  // waveform.
  const envelopeOverlay = createMemo<WaveformEnvelopeOverlay | null>(() => {
    const wb = workbench();
    const idx = selectedEffectIndex();
    const param = selectedEffectParam();
    if (!wb || idx === null || param === null) return null;
    if (wb.source.kind === "chiptune") return null;
    const node = wb.chain[idx];
    if (!node) return null;
    // Dispatch on (kind, param) — only valid pairings yield a
    // non-null envelope. Wrong combinations (e.g. param "cutoff" on a
    // volume node) fall through to null, which hides the overlay.
    const points: ReadonlyArray<EnvelopePoint> | null =
      param === "volume" && node.kind === "volume"
        ? node.params.points
        : param === "cutoff" && node.kind === "filter"
          ? node.params.cutoff
          : param === "q" && node.kind === "filter"
            ? node.params.q
            : param === "amount" && node.kind === "shaper"
              ? node.params.amount
              : param === "pitch" && node.kind === "pitch"
                ? node.params.envelope
                : null;
    if (!points) return null;
    const s = sample();
    const int8Length = s?.data.byteLength ?? 0;
    if (int8Length <= 0) return null;
    // Chain output up to (but NOT including) the active effect — that's
    // the input the envelope runs against, so its frames are the X-axis
    // domain.
    const stageInput = runChain(
      materializeSource(wb.source),
      wb.chain.slice(0, idx),
    );
    const sourceFrames = stageInput.channels[0]?.length ?? 0;
    if (sourceFrames <= 0) return null;
    return {
      points,
      axis: PARAM_AXES[param],
      sourceFrames,
      int8Length,
      onAddPoint: (p) => props.onAddEnvelopePoint(idx, param, p),
      onRemovePoint: (pi) => props.onRemoveEnvelopePoint(idx, param, pi),
      onPatchPoint: (pi, next) =>
        props.onPatchEnvelopePoint(idx, param, pi, next),
      onNudgeSegment: (li, dv) =>
        props.onNudgeEnvelopeSegment(idx, param, li, dv),
    };
  });

  // Drag-selection state lives in `state/sampleSelection.ts` (lifted from
  // here so App-level shortcuts like Cmd+A can write to it). The Waveform
  // (drag overlay) and the action buttons below it (Crop / Cut) both
  // read it. Selection is in BYTE indices over the int8 sample data,
  // half-open [start, end).
  // A selection only makes sense for the slot the user drew it on;
  // switching slots discards it. Same goes for the active-effect index —
  // it points into the previous slot's chain, so clear it too.
  createEffect(() => {
    currentSample();
    setSelection(null);
    setSelectedEffectIndex(null);
    setSelectedEffectParam(null);
  });
  // Same when the source flips to chiptune — selection is disabled in
  // that mode, so a stale selection from the prior sampler half would
  // otherwise sit invisible (overlay hidden) but still satisfy the
  // re-enable check on a switch back. Drop it.
  createEffect(() => {
    if (workbench()?.source.kind === "chiptune") setSelection(null);
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

  // True when the slot's "Sampler half" is actually an imported `.mod`
  // sample, not a real sampler workbench:
  //   - Slot has int8 data but no workbench at all (the typical post-load
  //     state). The Sampler tab is shown as selected but represents raw
  //     bytes — clicking "Convert to sampler workbench" upgrades it.
  //   - Slot is currently in chiptune mode, but an imported-sample stash
  //     exists from the Imported→Chiptune transition. The stash is what
  //     the Sampler tab restores to, so labelling it "Imported" mid-detour
  //     reminds the user that their `.mod` sample is still the alternate
  //     half.
  // Subscribes to `workbenches()` so chiptune→imported flips re-render
  // the picker without an explicit dep on the (non-reactive) stash map.
  const isImportedSample = createMemo(() => {
    const wb = workbench();
    if (!wb) return (sample()?.lengthWords ?? 0) > 0;
    workbenches();
    return (
      wb.source.kind === "chiptune" &&
      getImportedStash(currentSample() - 1) !== undefined
    );
  });

  // The hidden file input — clicked by the visible Load WAV button. Always
  // in the DOM so it's reachable regardless of which source kind is active.
  let wavInput: HTMLInputElement | undefined;

  /**
   * Drop focus from selects and checkboxes after the user commits a value,
   * so that subsequent piano-key presses ('a', 's', 'd', …) flow through
   * the global shortcut handler instead of being swallowed by the focused
   * <select> (which type-searches its options) or <input type="checkbox">
   * (where Space would re-toggle it). Text inputs and range sliders are
   * NOT blurred — text fields the user is mid-edit on shouldn't lose focus
   * on every keystroke, and sliders pass through letters per `focusKind`
   * in src/state/shortcuts.ts.
   *
   * `change` events bubble, so one handler at the SampleView root covers
   * every nested control (PipelineEditor selects, ChiptuneEditor selects,
   * Looping / Dither checkboxes) without per-component plumbing.
   */
  const blurOnCommit = (e: Event) => {
    const t = e.target;
    if (
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLInputElement && t.type === "checkbox")
    ) {
      t.blur();
    }
  };

  return (
    <div class="sampleview" onChange={blurOnCommit}>
      <header class="sampleview__header">
        <div class="source-picker" role="tablist" aria-label="Sample source">
          {SOURCE_KINDS.map((k) => {
            // The Sampler tab swaps to "Imported" while the slot is still
            // raw int8 — there's no workbench, so the effect chain isn't
            // available yet. The label hands that fact to the user without
            // a separate help line.
            const labelOf = () =>
              k === "sampler" && isImportedSample()
                ? "Imported"
                : SOURCE_LABELS[k];
            const titleOf = () => {
              if (k === "sampler" && isImportedSample()) {
                return workbench()?.source.kind === "chiptune"
                  ? "Restore the imported sample you had before switching to Chiptune"
                  : "Imported sample bytes (e.g. from a .mod). Use “Convert to sampler workbench” to enable the effect chain.";
              }
              return `Use the ${SOURCE_LABELS[k]} source for this slot`;
            };
            return (
              <button
                type="button"
                role="tab"
                aria-selected={activeSourceKind() === k}
                classList={{
                  "is-active": activeSourceKind() === k,
                  "source-picker__tab--imported":
                    k === "sampler" && isImportedSample(),
                }}
                title={titleOf()}
                onClick={() => props.onSetSourceKind(k)}
              >
                {labelOf()}
              </button>
            );
          })}
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
          <Show
            when={
              (sample() && sample()!.lengthWords > 0 && !workbench()) ||
              workbench()?.source.kind === "chiptune"
            }
          >
            <button
              type="button"
              title={
                workbench()?.source.kind === "chiptune"
                  ? "Freeze this slot's chiptune render as a sampler workbench's source. Synth params are stashed so toggling back to Chiptune restores them."
                  : "Wrap this sample's bytes as a sampler workbench so the effect chain becomes available"
              }
              onClick={
                workbench()?.source.kind === "chiptune"
                  ? props.onConvertChiptuneToSampler
                  : props.onConvertToSampler
              }
            >
              Convert to sampler
            </button>
          </Show>
          <button
            type="button"
            onClick={props.onDuplicate}
            disabled={
              !sample() || sample()!.lengthWords === 0 || !props.canDuplicate
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
            snap={(v) =>
              Math.max(
                PT_FINETUNE_MIN,
                Math.min(PT_FINETUNE_MAX, Math.round(v)),
              )
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
            <label>
              <span class="samplemeta__label">Looping</span>
              <span class="samplemeta__check">
                <input
                  type="checkbox"
                  checked={isLooping()}
                  disabled={sample()!.lengthWords === 0}
                  onChange={(e) => {
                    const slot = currentSample() - 1;
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
                      // No usable selection — fall back to the loop the user
                      // had configured before disabling, then to "whole sample"
                      // for slots that have never had one. Stash bounds are
                      // clamped to the current sample length so a sample that
                      // shrunk under the stash (crop, target-note swap) still
                      // produces a valid PT loop.
                      const stashed = getStashedLoop(slot);
                      const lengthWords = sample()!.lengthWords;
                      if (stashed && stashed.loopLengthWords > 1) {
                        const start = Math.min(
                          stashed.loopStartWords,
                          Math.max(0, lengthWords - 2),
                        );
                        const length = Math.max(
                          2,
                          Math.min(
                            stashed.loopLengthWords,
                            lengthWords - start,
                          ),
                        );
                        props.onPatch({
                          loopStartWords: start,
                          loopLengthWords: length,
                        });
                        return;
                      }
                      props.onPatch({
                        loopStartWords: 0,
                        loopLengthWords: lengthWords,
                      });
                    } else {
                      // Stash the bounds before clearing them so the next
                      // re-enable can restore the same window. Captured here
                      // (not in App.patchCurrentSample) because the stash is
                      // a UI-affordance concept, scoped to this checkbox.
                      const s = sample()!;
                      if (s.loopLengthWords > 1) {
                        stashLoop(slot, {
                          loopStartWords: s.loopStartWords,
                          loopLengthWords: s.loopLengthWords,
                        });
                      }
                      // PT no-loop sentinel.
                      props.onPatch({ loopLengthWords: 1 });
                    }
                  }}
                />
                <span>Enabled</span>
              </span>
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
          // Same reasoning for selection: any user-drawn range would be
          // wiped on the next synth edit, and the selection-action row
          // (Crop / Cut / range-aware effects) is hidden in chiptune mode
          // anyway, so a draggable selection would be inert.
          selectable={workbench()?.source.kind !== "chiptune"}
          envelope={envelopeOverlay()}
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
                const len = sample()?.data.length ?? 0;
                if (len < 2) return;
                setSelection({ start: 0, end: len });
              }}
              disabled={(sample()?.data.length ?? 0) < 2}
              title="Select the whole waveform (⌘A)"
            >
              Select all
            </button>
            {/* Resolve the byte range Copy / Cut act on: selection if
                non-empty, otherwise the whole sample. Mirrors the App
                handler's `effectiveSampleRange` so the button-driven and
                keyboard-driven paths agree on what gets copied. */}
            <button
              type="button"
              onClick={() => {
                const sel = selection();
                const len = sample()?.data.length ?? 0;
                const start = sel ? sel.start : 0;
                const end = sel ? sel.end : len;
                if (end - start < 1) return;
                props.onCopySelection(start, end);
              }}
              disabled={(sample()?.data.length ?? 0) < 1}
              title="Copy the selection (or the whole sample) to the clipboard (⌘C)"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                const sel = selection();
                const len = sample()?.data.length ?? 0;
                const start = sel ? sel.start : 0;
                const end = sel ? sel.end : len;
                if (end - start < 1) return;
                props.onCutSelection(start, end);
                setSelection(null);
              }}
              disabled={(sample()?.data.length ?? 0) < 1}
              title="Copy the selection (or the whole sample) to the clipboard, then remove it (⌘X)"
            >
              Cut
            </button>
            <button
              type="button"
              onClick={() => props.onPasteSampleClipboard()}
              disabled={!props.sampleClipboardHasData}
              title="Replace the slot's data with the sample clipboard contents (⌘V)"
            >
              Paste
            </button>
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
              disabled={false}
              onUpdate={props.onUpdateChiptune}
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
            onSetEffectBypass={props.onSetEffectBypass}
            onApplyChain={props.onApplyChain}
            onSetMonoMix={props.onSetMonoMix}
            onSetTargetNote={props.onSetTargetNote}
            onSetResampleMode={props.onSetResampleMode}
            onSetDither={props.onSetDither}
            selectedEffectIndex={selectedEffectIndex()}
            onSelectEffect={(i) => {
              setSelectedEffectIndex(i);
              // Auto-pick the right envelope for the kind we just
              // selected; the chain-li click handler in PipelineEditor
              // doesn't know the node, so we look it up here.
              if (i === null) {
                setSelectedEffectParam(null);
                return;
              }
              const node = workbench()?.chain[i];
              if (!node) return;
              setSelectedEffectParam(defaultParamForKind(node.kind));
            }}
            selectedEffectParam={selectedEffectParam()}
            onSelectParam={setSelectedEffectParam}
          />
        </Show>
      </Show>
    </div>
  );
};
