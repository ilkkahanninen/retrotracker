import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type Component } from 'solid-js';
import type { Sample, Song } from '../core/mod/types';
import { currentSample } from '../state/edit';
import { workbenches } from '../state/sampleWorkbench';
import { previewFrame } from '../state/preview';
import { transport } from '../state/song';
import {
  EFFECT_KINDS, EFFECT_LABELS,
  type EffectKind, type EffectNode, type MonoMix, type SampleWorkbench,
} from '../core/audio/sampleWorkbench';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'] as const;
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
export interface SampleSelection { start: number; end: number; }

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
  /** Pipeline editing — only meaningful when a workbench exists for the slot. */
  onAddEffect: (kind: EffectKind) => void;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
}

/** Editor for the sample under `currentSample()`: waveform + metadata + load. */
export const SampleView: Component<Props> = (props) => {
  const sample = createMemo(() => props.song.samples[currentSample() - 1] ?? null);
  const slotIndex = createMemo(() => String(currentSample()).padStart(2, '0'));
  const lengthBytes = createMemo(() => (sample()?.lengthWords ?? 0) * 2);
  const isLooping = createMemo(() => (sample()?.loopLengthWords ?? 0) > 1);
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
  const editingDisabled = createMemo(() => transport() === 'playing');

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
    input.value = ''; // re-allow picking the same file
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    props.onLoadWav(buf, file.name);
  };

  return (
    <div class="sampleview">
      <header class="sampleview__header">
        <h2>Sample {slotIndex()}</h2>
        <div class="sampleview__actions">
          <label class="file-button" title="Load a WAV file into this sample slot">
            <input type="file" accept=".wav,audio/wav,audio/x-wav" hidden onChange={onPickWav} />
            Load WAV…
          </label>
          <button
            type="button"
            onClick={props.onClear}
            disabled={!sample() || sample()!.lengthWords === 0}
          >Clear sample</button>
        </div>
      </header>

      <Show when={sample()} fallback={<p class="placeholder">Select a sample slot from the list.</p>}>
        <Waveform
          sample={sample()!}
          onPatch={props.onPatch}
          selection={selection()}
          onSelect={setSelection}
        />
        {/* Selection-action row: always rendered so the buttons don't
            shift in and out as the user drags. They disable when there's
            nothing meaningful to crop/cut. */}
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
          >Crop</button>
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
          >Cut</button>
          <Show when={selection()}>
            <span class="sampleview__selection-info">
              Selection: bytes {selection()!.start} – {selection()!.end} ({selection()!.end - selection()!.start} bytes)
            </span>
          </Show>
        </div>
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
              {lengthBytes()} bytes ({sample()!.lengthWords} words)
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
                props.onPatch({ volume: Math.max(0, Math.min(PT_VOLUME_MAX, v)) });
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
                    const end   = sel.end & ~1;
                    if (end - start >= 2) {
                      props.onPatch({
                        loopStartWords:  start >> 1,
                        loopLengthWords: (end - start) >> 1,
                      });
                      setSelection(null);
                      return;
                    }
                  }
                  // No (usable) selection — default loop = whole sample.
                  props.onPatch({ loopStartWords: 0, loopLengthWords: sample()!.lengthWords });
                } else {
                  // PT no-loop sentinel.
                  props.onPatch({ loopLengthWords: 1 });
                }
              }}
            />
            <span>Loop</span>
          </label>
          <Show when={isLooping()}>
            <p class="samplemeta__hint">
              Looping {sample()!.loopStartWords} – {sample()!.loopStartWords + sample()!.loopLengthWords} (words). Drag the cyan handles on the waveform to adjust.
            </p>
          </Show>
        </div>
        <Show when={workbench()}>
          <PipelineEditor
            wb={workbench()!}
            onAddEffect={props.onAddEffect}
            onRemoveEffect={props.onRemoveEffect}
            onMoveEffect={props.onMoveEffect}
            onPatchEffect={props.onPatchEffect}
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
}

/** Either dragging a loop boundary, or sweeping a selection range. */
type DragState =
  | { kind: 'loop'; which: 'start' | 'end' }
  | { kind: 'select'; anchorByte: number };

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
  const [hover, setHover] = createSignal<'start' | 'end' | null>(null);

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
  const handleAt = (x: number): 'start' | 'end' | null => {
    const s = props.sample;
    if (s.loopLengthWords <= 1) return null;
    const dataLen = s.data.length;
    if (dataLen === 0) return null;
    const xs = xForByte(s.loopStartWords * 2, dataLen);
    const xe = xForByte((s.loopStartWords + s.loopLengthWords) * 2, dataLen);
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? 'start' : 'end';
  };

  const onMouseDown = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const handle = handleAt(x);
    if (handle) {
      setDrag({ kind: 'loop', which: handle });
      e.preventDefault();
      return;
    }
    // Empty space → start a selection sweep. Anchor the start at the click
    // and let onMouseMove extend the end as the pointer moves.
    const dataLen = props.sample.data.length;
    if (dataLen === 0) return;
    const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
    setDrag({ kind: 'select', anchorByte: byte });
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
    if (d.kind === 'loop') {
      // Clamp to sample bounds and round to a word boundary (PT's loop fields
      // are word-aligned).
      const word = Math.max(0, Math.min(s.lengthWords, Math.round(byteForX(x, dataLen) / 2)));
      if (d.which === 'start') {
        // Keep at least 2 words of loop so the boundaries never cross.
        const endWord = s.loopStartWords + s.loopLengthWords;
        const newStart = Math.max(0, Math.min(word, endWord - 2));
        props.onPatch({
          loopStartWords: newStart,
          loopLengthWords: endWord - newStart,
        });
      } else {
        const newEnd = Math.max(s.loopStartWords + 2, Math.min(word, s.lengthWords));
        props.onPatch({ loopLengthWords: newEnd - s.loopStartWords });
      }
    } else {
      // Selection sweep — track the pointer in BYTE space (the user wants
      // sample-accurate boundaries, not word-aligned ones; the crop/cut
      // handlers are responsible for any alignment they need).
      const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
      props.onSelect({
        start: Math.min(d.anchorByte, byte),
        end:   Math.max(d.anchorByte, byte),
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
      if (d?.kind === 'select') {
        const sel = props.selection;
        if (sel && sel.start === sel.end) props.onSelect(null);
      }
      setDrag(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    onCleanup(() => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    });
  });

  // Waveform layer: redrawn only when the underlying sample changes.
  createEffect(() => {
    const c = waveCanvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    // Background.
    ctx.fillStyle = '#1c1e26';
    ctx.fillRect(0, 0, W, H);

    // Center line.
    ctx.fillStyle = '#2a2d38';
    ctx.fillRect(0, H / 2, W, 1);

    const data = props.sample.data;
    if (data.byteLength === 0) return;

    ctx.fillStyle = '#5ec8ff';
    ctx.strokeStyle = '#5ec8ff';
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
        const end = Math.min(data.length, Math.floor((x + 1) * samplesPerPixel));
        if (start >= end) continue;
        let mn = 127;
        let mx = -128;
        if (prev !== null) { if (prev < mn) mn = prev; if (prev > mx) mx = prev; }
        for (let i = start; i < end; i++) {
          const v = data[i]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        prev = data[end - 1]!;
        const yMax = yFor(mx);
        const yMin = yFor(mn);
        ctx.fillRect(x, Math.min(yMax, yMin), 1, Math.max(1, Math.abs(yMax - yMin)));
      }
    }

    drawLoopOverlay(ctx, props.sample, W, H, data.length);
  });

  // Playhead layer: redrawn on every previewFrame tick. The whole canvas is
  // cleared first because we don't keep track of the previous cursor x —
  // clearing 1024×160 transparent pixels is cheaper than diff-painting.
  createEffect(() => {
    const c = playheadCanvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const dataLen = props.sample.data.length;

    // Selection overlay (drawn under the playhead so the cursor stays
    // legible across the highlighted band).
    const sel = props.selection;
    if (sel && dataLen > 0 && sel.end > sel.start) {
      const x0 = xForByte(sel.start, dataLen);
      const x1 = xForByte(sel.end, dataLen);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
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
    ctx.fillStyle = '#ff7a59';
    ctx.fillRect(Math.floor(x), 0, 1, H);
  });

  return (
    <div
      class="waveform"
      ref={(el) => (container = el)}
      classList={{
        'waveform--grab':     hover() !== null && !drag(),
        'waveform--grabbing': drag()?.kind === 'loop',
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
  ctx.fillStyle = 'rgba(94, 200, 255, 0.18)';
  ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  ctx.fillStyle = '#5ec8ff';
  ctx.fillRect(x0, 0, 1, h);
  ctx.fillRect(Math.max(0, x1 - 1), 0, 1, h);
}

// ─── Pipeline editor ─────────────────────────────────────────────────────

interface PipelineEditorProps {
  wb: SampleWorkbench;
  onAddEffect: (kind: EffectKind) => void;
  onRemoveEffect: (index: number) => void;
  onMoveEffect: (index: number, delta: -1 | 1) => void;
  onPatchEffect: (index: number, next: EffectNode) => void;
  onSetMonoMix: (monoMix: MonoMix) => void;
  onSetTargetNote: (targetNote: number | null) => void;
}

const PipelineEditor: Component<PipelineEditorProps> = (props) => {
  const channels = () => props.wb.source.channels.length;
  const sourceFrames = () => props.wb.source.channels[0]?.length ?? 0;

  return (
    <section class="pipeline">
      <header class="pipeline__header">
        <h3>Effects</h3>
        <span class="pipeline__source">
          {props.wb.sourceName} · {props.wb.source.sampleRate} Hz ·{' '}
          {channels() === 1 ? 'mono' : channels() === 2 ? 'stereo' : `${channels()} ch`} ·{' '}
          {sourceFrames()} frames
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
                >↑</button>
                <button
                  type="button"
                  title="Move down"
                  aria-label={`Move effect ${i + 1} down`}
                  disabled={i === props.wb.chain.length - 1}
                  onClick={() => props.onMoveEffect(i, 1)}
                >↓</button>
                <button
                  type="button"
                  title="Remove effect"
                  aria-label={`Remove effect ${i + 1}`}
                  onClick={() => props.onRemoveEffect(i)}
                >×</button>
              </div>
              <div class="effect-node__body">
                <span class="effect-node__kind">{EFFECT_LABELS[node().kind]}</span>
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
      <div class="pipeline__add">
        <select
          aria-label="Add effect"
          value=""
          onChange={(e) => {
            const v = e.currentTarget.value as EffectKind | '';
            if (!v) return;
            props.onAddEffect(v);
            e.currentTarget.value = '';
          }}
        >
          <option value="">+ Add effect…</option>
          <For each={EFFECT_KINDS}>
            {(k) => <option value={k}>{EFFECT_LABELS[k]}</option>}
          </For>
        </select>
      </div>
      <div class="pipeline__transformer">
        <span class="pipeline__transformer-label">PT export · 8-bit signed mono</span>
        <Show when={channels() > 1}>
          <label>
            <span class="samplemeta__label">Mono mix</span>
            <select
              aria-label="Mono mix"
              value={props.wb.pt.monoMix}
              onChange={(e) => props.onSetMonoMix(e.currentTarget.value as MonoMix)}
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
            value={props.wb.pt.targetNote === null ? '' : String(props.wb.pt.targetNote)}
            onChange={(e) => {
              const v = e.currentTarget.value;
              props.onSetTargetNote(v === '' ? null : parseInt(v, 10));
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

const EffectParams: Component<EffectParamsProps> = (props) => {
  // Non-keyed Match (static children, no `(n) => ...` callback) so the
  // controlled <input>s aren't disposed every time the user types — focus
  // would otherwise jump on every keystroke. Each Match's `when` predicate
  // narrows the discriminated union, but TS can't see that across the
  // children boundary, so we re-narrow with typed accessors.
  const asGain = () => props.node as Extract<EffectNode, { kind: 'gain' }>;
  const asCrop = () => props.node as Extract<EffectNode, { kind: 'crop' }>;
  const asCut  = () => props.node as Extract<EffectNode, { kind: 'cut' }>;
  const asFade = () => props.node as Extract<EffectNode, { kind: 'fadeIn' | 'fadeOut' }>;
  return (
    <Switch>
      <Match when={props.node.kind === 'gain'}>
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
              props.onPatch({ kind: 'gain', params: { gain: Math.max(0, v) } });
            }}
          />
        </label>
      </Match>
      <Match when={props.node.kind === 'normalize'}>
        <span class="effect-node__hint">Scales to peak ±1.0</span>
      </Match>
      <Match when={props.node.kind === 'reverse'}>
        <span class="effect-node__hint">Plays backwards</span>
      </Match>
      <Match when={props.node.kind === 'crop'}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Start (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asCrop().params.startFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              props.onPatch({
                kind: 'crop',
                params: { startFrame: Math.max(0, v), endFrame: asCrop().params.endFrame },
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
            value={asCrop().params.endFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              props.onPatch({
                kind: 'crop',
                params: { startFrame: asCrop().params.startFrame, endFrame: Math.max(0, v) },
              });
            }}
          />
        </label>
      </Match>
      <Match when={props.node.kind === 'cut'}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Start (frame)</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asCut().params.startFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              props.onPatch({
                kind: 'cut',
                params: { startFrame: Math.max(0, v), endFrame: asCut().params.endFrame },
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
            value={asCut().params.endFrame}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              props.onPatch({
                kind: 'cut',
                params: { startFrame: asCut().params.startFrame, endFrame: Math.max(0, v) },
              });
            }}
          />
        </label>
      </Match>
      <Match when={props.node.kind === 'fadeIn' || props.node.kind === 'fadeOut'}>
        <label class="effect-node__param">
          <span class="samplemeta__label">Frames</span>
          <input
            type="number"
            min="0"
            max={props.sourceFrames}
            value={asFade().params.frames}
            onInput={(e) => {
              const v = parseInt(e.currentTarget.value, 10);
              if (!Number.isFinite(v)) return;
              props.onPatch({ kind: asFade().kind, params: { frames: Math.max(0, v) } });
            }}
          />
        </label>
      </Match>
    </Switch>
  );
};
