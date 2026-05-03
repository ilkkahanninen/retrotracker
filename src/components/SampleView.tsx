import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import type { Sample, Song } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { workbenches } from "../state/sampleWorkbench";
import { previewFrame } from "../state/preview";
import { transport } from "../state/song";
import {
  EFFECT_LABELS,
  SOURCE_KINDS,
  SOURCE_LABELS,
  materializeSource,
  sourceDisplayName,
  type EffectKind,
  type EffectNode,
  type MonoMix,
  type SampleSource,
  type SampleWorkbench,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import {
  COMBINE_MODES, COMBINE_LABELS,
  CYCLE_FRAMES_MIN, CYCLE_FRAMES_MAX,
  SHAPE_INDEX_MIN, SHAPE_INDEX_MAX,
  PHASE_SPLIT_MIN, PHASE_SPLIT_MAX,
  snapCycleFramesToMusical,
  type ChiptuneParams, type CombineMode, type Oscillator,
} from "../core/audio/chiptune";
import { truncateSampleAtLoopEnd } from "../core/audio/loopTruncate";
import { Slider } from "./Slider";

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

const NOTE_NAMES = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
] as const;
function noteIndexName(i: number): string {
  return `${NOTE_NAMES[i % 12]}${1 + Math.floor(i / 12)}`;
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

/** A user-drawn range over the int8 sample data (byte indices, half-open). */
export interface SampleSelection {
  start: number;
  end: number;
}

interface Props {
  song: Song;
  /** Bytes of a `.wav` file picked by the user, plus the original file name. */
  onLoadWav: (bytes: Uint8Array, filename: string) => void;
  onClear: () => void;
  onPatch: (patch: Partial<Sample>) => void;
  /** Replace sample.data with the [startByte, endByte) slice; loop translates accordingly. */
  onCropToSelection: (startByte: number, endByte: number) => void;
  /** Replace sample.data with everything OUTSIDE [startByte, endByte). */
  onCutSelection: (startByte: number, endByte: number) => void;
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
            disabled={!selection() || selection()!.end - selection()!.start < 2}
            title="Keep the selected range, discard the rest"
          >
            Crop
          </button>
          <button
            type="button"
            onClick={() => {
              const sel = selection();
              if (!sel) return;
              props.onCutSelection(sel.start, sel.end);
              setSelection(null);
            }}
            disabled={!selection() || selection()!.end - selection()!.start < 2}
            title="Remove the selected range, keep the rest"
          >
            Cut
          </button>
          <For each={EFFECT_BUTTON_KINDS}>
            {(kind) => (
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
                disabled={!workbench() || editingDisabled()}
                title={titleForEffectButton(kind, selection() !== null)}
              >
                {EFFECT_LABELS[kind]}
              </button>
            )}
          </For>
          <Show when={selection()}>
            <span class="sampleview__selection-info">
              Selection: bytes {selection()!.start} – {selection()!.end} (
              {selection()!.end - selection()!.start} bytes)
            </span>
          </Show>
        </div>
        </Show>
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
          <label>
            <span class="samplemeta__label">Volume (0–{PT_VOLUME_MAX})</span>
            <input
              type="number"
              min={0}
              max={PT_VOLUME_MAX}
              value={sample()!.volume}
              disabled={editingDisabled()}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!Number.isFinite(v)) return;
                props.onPatch({
                  volume: Math.max(0, Math.min(PT_VOLUME_MAX, v)),
                });
              }}
            />
          </label>
          <label>
            <span class="samplemeta__label">
              Finetune ({PT_FINETUNE_MIN} to +{PT_FINETUNE_MAX})
            </span>
            <input
              type="number"
              min={PT_FINETUNE_MIN}
              max={PT_FINETUNE_MAX}
              value={signedFinetune(sample()!.finetune)}
              disabled={editingDisabled()}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!Number.isFinite(v)) return;
                props.onPatch({ finetune: encodeFinetune(v) });
              }}
            />
          </label>
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
        <Show when={workbench()?.source.kind === "chiptune" ? workbench()!.source : null}>
          {(src) => (
            <ChiptuneEditor
              params={(src() as Extract<SampleSource, { kind: "chiptune" }>).params}
              disabled={editingDisabled()}
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
            onApplyChain={props.onApplyChain}
            onSetMonoMix={props.onSetMonoMix}
            onSetTargetNote={props.onSetTargetNote}
          />
        </Show>
      </Show>
    </div>
  );
};

/**
 * Min/max-bucketed PCM rendering. Two stacked canvases: the bottom one is
 * the waveform (repainted only when `props.sample` changes), the top one is
 * a transparent overlay that holds just the playhead (repainted on every
 * `previewFrame` tick). Splitting the layers keeps the heavy bucket loop
 * out of the 60 Hz update path and side-steps the "redraw the whole wave
 * to move the cursor" problem.
 */
interface WaveformProps {
  sample: Sample;
  onPatch: (patch: Partial<Sample>) => void;
  selection: SampleSelection | null;
  onSelect: (s: SampleSelection | null) => void;
  /** When false, hide the loop overlay and ignore loop-handle drag. */
  showLoop: boolean;
}

/** Either dragging a loop boundary, or sweeping a selection range. */
type DragState =
  | { kind: "loop"; which: "start" | "end" }
  | { kind: "select"; anchorByte: number };

const Waveform: Component<WaveformProps> = (props) => {
  let waveCanvas: HTMLCanvasElement | undefined;
  let playheadCanvas: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;
  const W = 1024;
  const H = 160;
  /** Pointer must be within this many canvas-internal pixels of a loop line to grab it. */
  const HANDLE_HIT_PX = 8;

  /** Active drag, if any. */
  const [drag, setDrag] = createSignal<DragState | null>(null);
  /** Hover over a handle (drives cursor) — independent of drag because we
   *  also want the cursor while the user is grabbing. */
  const [hover, setHover] = createSignal<"start" | "end" | null>(null);

  /** Same byte→x mapping the waveform paths use, so the lines line up. */
  const xForByte = (byte: number, dataLen: number): number => {
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      return (byte / span) * (W - 1);
    }
    return (byte * W) / dataLen;
  };

  /** Inverse of xForByte: convert a canvas-internal x back to a byte index. */
  const byteForX = (x: number, dataLen: number): number => {
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      return Math.round((x / Math.max(1, W - 1)) * span);
    }
    return Math.round((x * dataLen) / W);
  };

  /** Convert a clientX from a mouse event to canvas-internal x (0..W). */
  const clientToCanvasX = (clientX: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  };

  /** Mouse-x near a loop boundary? Returns which one, or null. */
  const handleAt = (x: number): "start" | "end" | null => {
    const s = props.sample;
    if (!props.showLoop) return null;
    if (s.loopLengthWords <= 1) return null;
    const dataLen = s.data.length;
    if (dataLen === 0) return null;
    const xs = xForByte(s.loopStartWords * 2, dataLen);
    const xe = xForByte((s.loopStartWords + s.loopLengthWords) * 2, dataLen);
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? "start" : "end";
  };

  const onMouseDown = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const handle = handleAt(x);
    if (handle) {
      setDrag({ kind: "loop", which: handle });
      e.preventDefault();
      return;
    }
    // Empty space → start a selection sweep. Anchor the start at the click
    // and let onMouseMove extend the end as the pointer moves.
    const dataLen = props.sample.data.length;
    if (dataLen === 0) return;
    const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
    setDrag({ kind: "select", anchorByte: byte });
    props.onSelect({ start: byte, end: byte });
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const d = drag();
    if (!d) {
      setHover(handleAt(x));
      return;
    }
    const s = props.sample;
    const dataLen = s.data.length;
    if (d.kind === "loop") {
      // Clamp to sample bounds and round to a word boundary (PT's loop fields
      // are word-aligned).
      const word = Math.max(
        0,
        Math.min(s.lengthWords, Math.round(byteForX(x, dataLen) / 2)),
      );
      if (d.which === "start") {
        // Keep at least 2 words of loop so the boundaries never cross.
        const endWord = s.loopStartWords + s.loopLengthWords;
        const newStart = Math.max(0, Math.min(word, endWord - 2));
        props.onPatch({
          loopStartWords: newStart,
          loopLengthWords: endWord - newStart,
        });
      } else {
        const newEnd = Math.max(
          s.loopStartWords + 2,
          Math.min(word, s.lengthWords),
        );
        props.onPatch({ loopLengthWords: newEnd - s.loopStartWords });
      }
    } else {
      // Selection sweep — track the pointer in BYTE space (the user wants
      // sample-accurate boundaries, not word-aligned ones; the crop/cut
      // handlers are responsible for any alignment they need).
      const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
      props.onSelect({
        start: Math.min(d.anchorByte, byte),
        end: Math.max(d.anchorByte, byte),
      });
    }
  };

  const onMouseLeave = () => {
    if (!drag()) setHover(null);
  };

  // Window-level move/up while dragging, so the user can drag past the canvas
  // edge without losing the grab. Cleaned up the moment the drag ends.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => {
      // A click without movement (anchor === pointer) collapses the
      // selection — clear it so the action row doesn't linger empty.
      const d = drag();
      if (d?.kind === "select") {
        const sel = props.selection;
        if (sel && sel.start === sel.end) props.onSelect(null);
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    onCleanup(() => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    });
  });

  // Waveform layer: redrawn only when the underlying sample changes.
  createEffect(() => {
    const c = waveCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // Background.
    ctx.fillStyle = "#1c1e26";
    ctx.fillRect(0, 0, W, H);

    // Center line.
    ctx.fillStyle = "#2a2d38";
    ctx.fillRect(0, H / 2, W, 1);

    const data = props.sample.data;
    if (data.byteLength === 0) return;

    ctx.fillStyle = "#5ec8ff";
    ctx.strokeStyle = "#5ec8ff";
    ctx.lineWidth = 1;
    const yFor = (v: number) => H / 2 - (v / 128) * (H / 2 - 1);

    if (data.length <= W) {
      // Short sample: every byte gets its own (possibly sub-pixel) x and we
      // trace a polyline through them. Stretches the wave to fill the canvas
      // and keeps adjacent samples visually connected.
      ctx.beginPath();
      const span = Math.max(1, data.length - 1);
      for (let i = 0; i < data.length; i++) {
        const x = (i / span) * (W - 1);
        const y = yFor(data[i]!);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      // More samples than pixels: bucket each column to its sample range and
      // fill a min/max bar. Bridge each bar to the previous column's last
      // sample so columns whose bucket holds only one sample still connect
      // visually to their neighbour.
      const samplesPerPixel = data.length / W;
      let prev: number | null = null;
      for (let x = 0; x < W; x++) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.min(
          data.length,
          Math.floor((x + 1) * samplesPerPixel),
        );
        if (start >= end) continue;
        let mn = 127;
        let mx = -128;
        if (prev !== null) {
          if (prev < mn) mn = prev;
          if (prev > mx) mx = prev;
        }
        for (let i = start; i < end; i++) {
          const v = data[i]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        prev = data[end - 1]!;
        const yMax = yFor(mx);
        const yMin = yFor(mn);
        ctx.fillRect(
          x,
          Math.min(yMax, yMin),
          1,
          Math.max(1, Math.abs(yMax - yMin)),
        );
      }
    }

    if (props.showLoop) drawLoopOverlay(ctx, props.sample, W, H, data.length);
  });

  // Playhead layer: redrawn on every previewFrame tick. The whole canvas is
  // cleared first because we don't keep track of the previous cursor x —
  // clearing 1024×160 transparent pixels is cheaper than diff-painting.
  createEffect(() => {
    const c = playheadCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const dataLen = props.sample.data.length;

    // Selection overlay (drawn under the playhead so the cursor stays
    // legible across the highlighted band).
    const sel = props.selection;
    if (sel && dataLen > 0 && sel.end > sel.start) {
      const x0 = xForByte(sel.start, dataLen);
      const x1 = xForByte(sel.end, dataLen);
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.fillRect(Math.floor(x0), 0, 1, H);
      ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, H);
    }

    const pf = previewFrame();
    if (!pf || pf.slot !== currentSample() - 1) return;
    if (dataLen === 0) return;

    let x: number;
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      x = (pf.frame / span) * (W - 1);
    } else {
      x = (pf.frame * W) / dataLen;
    }
    ctx.fillStyle = "#ff7a59";
    ctx.fillRect(Math.floor(x), 0, 1, H);
  });

  return (
    <div
      class="waveform"
      ref={(el) => (container = el)}
      classList={{
        "waveform--grab": hover() !== null && !drag(),
        "waveform--grabbing": drag()?.kind === "loop",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <canvas
        class="waveform__layer"
        ref={(el) => (waveCanvas = el)}
        width={W}
        height={H}
      />
      <canvas
        class="waveform__layer waveform__playhead"
        ref={(el) => (playheadCanvas = el)}
        width={W}
        height={H}
      />
    </div>
  );
};

function drawLoopOverlay(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  w: number,
  h: number,
  dataLen: number,
): void {
  const loopStart = sample.loopStartWords * 2;
  const loopLen = sample.loopLengthWords * 2;
  if (loopLen <= 2 || dataLen <= 0) return;
  const x0 = Math.max(0, Math.min(w, (loopStart / dataLen) * w));
  const x1 = Math.max(0, Math.min(w, ((loopStart + loopLen) / dataLen) * w));
  ctx.fillStyle = "rgba(94, 200, 255, 0.18)";
  ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  ctx.fillStyle = "#5ec8ff";
  ctx.fillRect(x0, 0, 1, h);
  ctx.fillRect(Math.max(0, x1 - 1), 0, 1, h);
}

// ─── Pipeline editor ─────────────────────────────────────────────────────

interface PipelineEditorProps {
  wb: SampleWorkbench;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  /** Burn the chain into the source. See SampleView.Props.onApplyChain. */
  onApplyChain: () => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
}

const PipelineEditor: Component<PipelineEditorProps> = (props) => {
  // The chain operates on the materialised source — for chiptune that's a
  // synth cycle, for sampler the loaded WAV. Read both off the same memo.
  const materialised = createMemo(() => materializeSource(props.wb.source));
  const channels = () => materialised().channels.length;
  const sourceFrames = () => materialised().channels[0]?.length ?? 0;

  return (
    <section class="pipeline">
      <header class="pipeline__header">
        <span class="pipeline__source">
          {sourceDisplayName(props.wb.source)} · {materialised().sampleRate} Hz ·{" "}
          {channels() === 1
            ? "mono"
            : channels() === 2
              ? "stereo"
              : `${channels()} ch`}{" "}
          · {sourceFrames()} frames
        </span>
      </header>
      <ol class="pipeline__chain">
        {/* Index (not For) keys by position, so editing an effect's params
            updates the existing <li> instead of disposing and remounting it.
            Without this, a controlled <input> loses focus on every keystroke
            because the patch produces a new node object at the same index. */}
        <Index each={props.wb.chain}>
          {(node, i) => (
            <li class="effect-node">
              <div class="effect-node__controls">
                <button
                  type="button"
                  title="Move up"
                  aria-label={`Move effect ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => props.onMoveEffect(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  aria-label={`Move effect ${i + 1} down`}
                  disabled={i === props.wb.chain.length - 1}
                  onClick={() => props.onMoveEffect(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Remove effect"
                  aria-label={`Remove effect ${i + 1}`}
                  onClick={() => props.onRemoveEffect(i)}
                >
                  ×
                </button>
              </div>
              <div class="effect-node__body">
                <span class="effect-node__kind">
                  {EFFECT_LABELS[node().kind]}
                </span>
                <EffectParams
                  node={node()}
                  sourceFrames={sourceFrames()}
                  onPatch={(next) => props.onPatchEffect(i, next)}
                />
              </div>
            </li>
          )}
        </Index>
      </ol>
      <div class="pipeline__chain-actions">
        <button
          type="button"
          onClick={() => props.onApplyChain()}
          disabled={props.wb.chain.length === 0}
          title="Run the chain into the source and clear it. Useful after a Crop — the trimmed source shrinks the project file size, but playback stays identical."
        >
          Apply changes
        </button>
      </div>
      <div class="pipeline__transformer">
        <Show when={channels() > 1}>
          <label>
            <span class="samplemeta__label">Mono mix</span>
            <select
              aria-label="Mono mix"
              value={props.wb.pt.monoMix}
              onChange={(e) =>
                props.onSetMonoMix(e.currentTarget.value as MonoMix)
              }
            >
              <option value="average">Average channels</option>
              <option value="left">Left only</option>
              <option value="right">Right only</option>
            </select>
          </label>
        </Show>
        <label>
          <span class="samplemeta__label">Target note</span>
          <select
            aria-label="Target note"
            value={
              props.wb.pt.targetNote === null
                ? ""
                : String(props.wb.pt.targetNote)
            }
            onChange={(e) => {
              const v = e.currentTarget.value;
              props.onSetTargetNote(v === "" ? null : parseInt(v, 10));
            }}
          >
            <option value="">(none) — keep source rate</option>
            <For each={Array.from({ length: 36 }, (_, i) => i)}>
              {(i) => <option value={i}>{noteIndexName(i)}</option>}
            </For>
          </select>
        </label>
      </div>
    </section>
  );
};

interface EffectParamsProps {
  node: EffectNode;
  sourceFrames: number;
  onPatch: (next: EffectNode) => void;
}

/** Discriminated-union narrowing of the range-aware kinds. */
type RangeKind = "reverse" | "crop" | "cut" | "fadeIn" | "fadeOut";

const EffectParams: Component<EffectParamsProps> = (props) => {
  // Non-keyed Match (static children, no `(n) => ...` callback) so the
  // controlled <input>s aren't disposed every time the user types — focus
  // would otherwise jump on every keystroke. Each Match's `when` predicate
  // narrows the discriminated union, but TS can't see that across the
  // children boundary, so we re-narrow with typed accessors.
  const asGain = () => props.node as Extract<EffectNode, { kind: "gain" }>;
  const asRange = () => props.node as Extract<EffectNode, { kind: RangeKind }>;
  return (
    <Switch>
      <Match when={props.node.kind === "gain"}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Gain ×</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="20"
            value={asGain().params.gain}
            onInput={(e) => {
              const v = parseFloat(e.currentTarget.value);
              if (!Number.isFinite(v)) return;
              props.onPatch({ kind: "gain", params: { gain: Math.max(0, v) } });
            }}
          />
        </label>
      </Match>
      <Match when={props.node.kind === "normalize"}>
        <span class="effect-node__hint">Scales to peak ±1.0</span>
      </Match>
      <Match
        when={
          props.node.kind === "reverse" ||
          props.node.kind === "crop" ||
          props.node.kind === "cut" ||
          props.node.kind === "fadeIn" ||
          props.node.kind === "fadeOut"
        }
      >
        <label class="effect-node__param">
          <span class="samplemeta__label">Start (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asRange().params.startFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              const node = asRange();
              props.onPatch({
                kind: node.kind,
                params: {
                  startFrame: Math.max(0, v),
                  endFrame: node.params.endFrame,
                },
              });
            }}
          />
        </label>
        <label class="effect-node__param">
          <span class="samplemeta__label">End (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asRange().params.endFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              const node = asRange();
              props.onPatch({
                kind: node.kind,
                params: {
                  startFrame: node.params.startFrame,
                  endFrame: Math.max(0, v),
                },
              });
            }}
          />
        </label>
      </Match>
    </Switch>
  );
};

// ─── Chiptune editor ─────────────────────────────────────────────────────

interface ChiptuneEditorProps {
  params: ChiptuneParams;
  disabled: boolean;
  onUpdate: (patch: Partial<ChiptuneParams>) => void;
}

const SHAPE_HINT = "sine ─ tri ─ sq ─ saw";

const ChiptuneEditor: Component<ChiptuneEditorProps> = (props) => {
  const patchOsc1 = (patch: Partial<Oscillator>) =>
    props.onUpdate({ osc1: { ...props.params.osc1, ...patch } });
  const patchOsc2 = (patch: Partial<Oscillator>) =>
    props.onUpdate({ osc2: { ...props.params.osc2, ...patch } });

  return (
    <section class="chiptune">
      <div class="chiptune__group">
        <span class="chiptune__group-label">Synth</span>
        <div class="chiptune__sliders">
          <Slider
            label="Cycle frames"
            min={CYCLE_FRAMES_MIN}
            max={CYCLE_FRAMES_MAX}
            step={1}
            value={props.params.cycleFrames}
            disabled={props.disabled}
            // Snap to octave-aligned cycle lengths so a "C" pattern note
            // always plays as some C — never a detuned C-ish.
            snap={snapCycleFramesToMusical}
            format={(v) => `${v}`}
            onInput={(v) => props.onUpdate({ cycleFrames: v })}
          />
          <Slider
            label="Amplitude"
            min={0}
            max={1}
            step={0.01}
            value={props.params.amplitude}
            disabled={props.disabled}
            onInput={(v) => props.onUpdate({ amplitude: v })}
          />
        </div>
      </div>

      <OscillatorSliders
        label="Oscillator 1"
        osc={props.params.osc1}
        disabled={props.disabled}
        onUpdate={patchOsc1}
      />
      <OscillatorSliders
        label="Oscillator 2"
        osc={props.params.osc2}
        disabled={props.disabled}
        onUpdate={patchOsc2}
      />

      <div class="chiptune__group">
        <span class="chiptune__group-label">Combine</span>
        <div class="chiptune__modes" role="radiogroup" aria-label="Combine mode">
          {COMBINE_MODES.map((m) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.params.combineMode === m}
              classList={{ "is-active": props.params.combineMode === m }}
              disabled={props.disabled}
              onClick={() => props.onUpdate({ combineMode: m })}
            >
              {COMBINE_LABELS[m]}
            </button>
          ))}
        </div>
        <div class="chiptune__sliders">
          <Slider
            label="Amount"
            min={0}
            max={1}
            step={0.01}
            value={props.params.combineAmount}
            disabled={props.disabled}
            onInput={(v) => props.onUpdate({ combineAmount: v })}
          />
        </div>
      </div>
    </section>
  );
};

interface OscillatorSlidersProps {
  label: string;
  osc: Oscillator;
  disabled: boolean;
  onUpdate: (patch: Partial<Oscillator>) => void;
}

const OscillatorSliders: Component<OscillatorSlidersProps> = (props) => (
  <div class="chiptune__group">
    <span class="chiptune__group-label">{props.label}</span>
    <div class="chiptune__sliders">
      <Slider
        label="Shape"
        min={SHAPE_INDEX_MIN}
        max={SHAPE_INDEX_MAX}
        step={0.01}
        value={props.osc.shapeIndex}
        disabled={props.disabled}
        hint={SHAPE_HINT}
        onInput={(v) => props.onUpdate({ shapeIndex: v })}
      />
      <Slider
        label="Phase split"
        min={PHASE_SPLIT_MIN}
        max={PHASE_SPLIT_MAX}
        step={0.01}
        value={props.osc.phaseSplit}
        disabled={props.disabled}
        onInput={(v) => props.onUpdate({ phaseSplit: v })}
      />
    </div>
  </div>
);
