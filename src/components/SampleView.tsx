import { Show, createEffect, createMemo, type Component } from 'solid-js';
import type { Sample, Song } from '../core/mod/types';
import { currentSample } from '../state/edit';

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
}

/** Editor for the sample under `currentSample()`: waveform + metadata + load. */
export const SampleView: Component<Props> = (props) => {
  const sample = createMemo(() => props.song.samples[currentSample() - 1] ?? null);
  const slotIndex = createMemo(() => String(currentSample()).padStart(2, '0'));
  const lengthBytes = createMemo(() => (sample()?.lengthWords ?? 0) * 2);
  const isLooping = createMemo(() => (sample()?.loopLengthWords ?? 0) > 1);

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
        {(s) => (
          <>
            <Waveform sample={s()} />
            <div class="samplemeta">
              <label>
                <span class="samplemeta__label">Name</span>
                <input
                  type="text"
                  maxLength={SAMPLE_NAME_MAX}
                  value={s().name}
                  placeholder="(unnamed)"
                  onInput={(e) => props.onPatch({ name: e.currentTarget.value })}
                />
              </label>
              <label>
                <span class="samplemeta__label">Length</span>
                <span class="samplemeta__static">
                  {lengthBytes()} bytes ({s().lengthWords} words)
                </span>
              </label>
              <label>
                <span class="samplemeta__label">Volume (0–{PT_VOLUME_MAX})</span>
                <input
                  type="number"
                  min={0}
                  max={PT_VOLUME_MAX}
                  value={s().volume}
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
                  value={signedFinetune(s().finetune)}
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
                  max={s().lengthWords}
                  value={s().loopStartWords}
                  disabled={s().lengthWords === 0}
                  onInput={(e) => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (!Number.isFinite(v)) return;
                    props.onPatch({ loopStartWords: Math.max(0, Math.min(s().lengthWords, v)) });
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
                  max={Math.max(1, s().lengthWords)}
                  value={s().loopLengthWords}
                  disabled={s().lengthWords === 0}
                  onInput={(e) => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (!Number.isFinite(v)) return;
                    props.onPatch({
                      loopLengthWords: Math.max(1, Math.min(Math.max(1, s().lengthWords), v)),
                    });
                  }}
                />
              </label>
              <Show when={isLooping()}>
                <p class="samplemeta__hint">
                  Looping {s().loopStartWords} – {s().loopStartWords + s().loopLengthWords} (words)
                </p>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

/** Min/max-bucketed PCM rendering. Re-runs whenever the input sample changes. */
const Waveform: Component<{ sample: Sample }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;

  createEffect(() => {
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const h = c.height;

    // Background.
    ctx.fillStyle = '#1c1e26';
    ctx.fillRect(0, 0, w, h);

    // Center line.
    ctx.fillStyle = '#2a2d38';
    ctx.fillRect(0, h / 2, w, 1);

    const data = props.sample.data;
    if (data.byteLength === 0) return;

    // Bucket-and-fill: for each pixel column, find min/max across the slice
    // of samples that map to it and draw a vertical bar. Cheap, looks right.
    ctx.fillStyle = '#5ec8ff';
    const samplesPerPixel = Math.max(1, data.length / w);
    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * samplesPerPixel);
      const end = Math.min(data.length, Math.floor((x + 1) * samplesPerPixel));
      let mn = 127;
      let mx = -128;
      for (let i = start; i < end; i++) {
        const v = data[i]!;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const yMax = h / 2 - (mx / 128) * (h / 2 - 1);
      const yMin = h / 2 - (mn / 128) * (h / 2 - 1);
      ctx.fillRect(x, Math.min(yMax, yMin), 1, Math.max(1, Math.abs(yMax - yMin)));
    }

    // Loop-region overlay.
    const loopStart = props.sample.loopStartWords * 2;
    const loopLen = props.sample.loopLengthWords * 2;
    if (loopLen > 2 && data.length > 0) {
      const x0 = Math.max(0, Math.min(w, (loopStart / data.length) * w));
      const x1 = Math.max(0, Math.min(w, ((loopStart + loopLen) / data.length) * w));
      ctx.fillStyle = 'rgba(94, 200, 255, 0.18)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.fillStyle = '#5ec8ff';
      ctx.fillRect(x0, 0, 1, h);
      ctx.fillRect(Math.max(0, x1 - 1), 0, 1, h);
    }
  });

  return (
    <canvas
      class="waveform"
      ref={(el) => (canvas = el)}
      width={1024}
      height={160}
    />
  );
};
