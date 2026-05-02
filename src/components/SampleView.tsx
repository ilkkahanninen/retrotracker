import { For, Index, Match, Show, Switch, createEffect, createMemo, type Component } from 'solid-js';
import type { Sample, Song } from '../core/mod/types';
import { currentSample } from '../state/edit';
import { workbenches } from '../state/sampleWorkbench';
import { previewFrame } from '../state/preview';
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

interface Props {
  song: Song;
  /** Bytes of a `.wav` file picked by the user, plus the original file name. */
  onLoadWav: (bytes: Uint8Array, filename: string) => void;
  onClear: () => void;
  onPatch: (patch: Partial<Sample>) => void;
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
        <Waveform sample={sample()!} />
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
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!Number.isFinite(v)) return;
                props.onPatch({ finetune: encodeFinetune(v) });
              }}
            />
          </label>
          <label>
            <span class="samplemeta__label">Loop start (words)</span>
            <input
              type="number"
              min={0}
              max={sample()!.lengthWords}
              value={sample()!.loopStartWords}
              disabled={sample()!.lengthWords === 0}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!Number.isFinite(v)) return;
                props.onPatch({ loopStartWords: Math.max(0, Math.min(sample()!.lengthWords, v)) });
              }}
            />
          </label>
          <label>
            <span class="samplemeta__label">
              Loop length (words; 1 = no loop)
            </span>
            <input
              type="number"
              min={1}
              max={Math.max(1, sample()!.lengthWords)}
              value={sample()!.loopLengthWords}
              disabled={sample()!.lengthWords === 0}
              onInput={(e) => {
                const v = parseInt(e.currentTarget.value, 10);
                if (!Number.isFinite(v)) return;
                props.onPatch({
                  loopLengthWords: Math.max(1, Math.min(Math.max(1, sample()!.lengthWords), v)),
                });
              }}
            />
          </label>
          <Show when={isLooping()}>
            <p class="samplemeta__hint">
              Looping {sample()!.loopStartWords} – {sample()!.loopStartWords + sample()!.loopLengthWords} (words)
            </p>
          </Show>
        </div>
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
const Waveform: Component<{ sample: Sample }> = (props) => {
  let waveCanvas: HTMLCanvasElement | undefined;
  let playheadCanvas: HTMLCanvasElement | undefined;
  const W = 1024;
  const H = 160;

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

    const pf = previewFrame();
    if (!pf || pf.slot !== currentSample() - 1) return;

    const dataLen = props.sample.data.length;
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
    <div class="waveform">
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
