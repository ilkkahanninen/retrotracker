/**
 * High-quality offline-render mixer. Implements `Mixer` so the Replayer can
 * use it transparently in place of Paula — same DMA / period / volume API,
 * but without BLEP synthesis, RC/LED filters, or 2× oversampling.
 *
 * The point: when the user "bounces" a pattern selection to a sample slot,
 * Paula's analog character would print baked-in aliasing artefacts onto the
 * resulting int8. The CleanMixer reads the same sample registers and walks
 * each channel with a smooth fractional cursor (linear interpolation), then
 * sums per Paula's hard-pan convention. Output is bit-clean Float64 — the
 * Replayer's existing mid/side + 0.5 scaling step still applies.
 *
 * Trade-off vs. Paula: no BLEP means the absolute pitch of an aliased high
 * note can read 1-2 cents off in pathological cases (~22 kHz source content
 * at 8 kHz target rate); negligible for sample-bounce work where the user
 * picks a target note and the resampler runs at human-scale ratios.
 */

import type { Mixer } from './mixer';
import { PAULA_CLOCK_PAL } from '../mod/format';

const PAULA_VOICES = 4;

interface CleanVoice {
  /** Sample bytes the next DMA trigger will read from. Latched by `setSample`. */
  data: Int8Array | null;
  /** Latched start offset, in bytes, into `data`. */
  startOffsetBytes: number;
  /** Latched length in 16-bit words; total bytes = lengthWords * 2. */
  lengthWords: number;
  /** Latched loop start, in bytes. */
  loopStartBytes: number;
  /** Latched loop length in 16-bit words. ≤1 means "no loop" (PT sentinel). */
  loopLengthWords: number;
  /** Source-byte position the next output frame samples at. Float — sub-byte. */
  posBytes: number;
  /** Source-bytes per output frame. Derived from period via `periodToHz`. */
  bytesPerFrame: number;
  /** Volume 0..64, latched independently of DMA state. */
  volume: number;
  /** True while DMA is running for this voice. */
  active: boolean;
  /** Sample rate at the time of DMA start — held until next start to detect rate-change resync. */
  rateHz: number;
}

function newVoice(): CleanVoice {
  return {
    data: null,
    startOffsetBytes: 0,
    lengthWords: 0,
    loopStartBytes: 0,
    loopLengthWords: 0,
    posBytes: 0,
    bytesPerFrame: 0,
    volume: 0,
    active: false,
    rateHz: 0,
  };
}

export class CleanMixer implements Mixer {
  private readonly outputRate: number;
  /** Paula's "byte clock" — one source byte per period CCK ticks. */
  private static readonly PAULA_BYTE_CLOCK = PAULA_CLOCK_PAL / 2;
  private readonly voices: CleanVoice[] = [];
  private readonly channelPeaks = new Float64Array(PAULA_VOICES);

  constructor(outputRate: number) {
    this.outputRate = outputRate;
    for (let i = 0; i < PAULA_VOICES; i++) this.voices.push(newVoice());
  }

  setSample(
    ch: number,
    data: Int8Array,
    startOffsetBytes: number,
    lengthWords: number,
    loopStartBytes: number,
    loopLengthWords: number,
  ): void {
    const v = this.voices[ch]!;
    v.data = data;
    v.startOffsetBytes = startOffsetBytes;
    v.lengthWords = lengthWords;
    v.loopStartBytes = loopStartBytes;
    v.loopLengthWords = loopLengthWords;
  }

  setPeriod(ch: number, period: number): void {
    let p = period;
    if (p === 0) p = 65536;
    else if (p < 113) p = 113;
    const rateHz = CleanMixer.PAULA_BYTE_CLOCK / p;
    const v = this.voices[ch]!;
    v.rateHz = rateHz;
    v.bytesPerFrame = rateHz / this.outputRate;
  }

  setVolume(ch: number, vol: number): void {
    let r = vol & 0x7f;
    if (r > 64) r = 64;
    this.voices[ch]!.volume = r;
  }

  startDMA(ch: number): void {
    const v = this.voices[ch]!;
    if (!v.data) return;
    v.posBytes = v.startOffsetBytes;
    v.active = true;
  }

  stopDMA(ch: number): void {
    this.voices[ch]!.active = false;
  }

  setLEDFilter(_on: boolean): void {
    // No LED filter — that's an analog-character knob the user is opting out
    // of by choosing this mixer. Method exists to satisfy the Mixer contract.
  }

  generate(outL: Float64Array, outR: Float64Array, frames: number, offset: number): void {
    for (let i = 0; i < frames; i++) {
      outL[offset + i] = 0;
      outR[offset + i] = 0;
    }

    for (let ci = 0; ci < PAULA_VOICES; ci++) {
      const v = this.voices[ci]!;
      if (!v.active || !v.data) continue;
      // PT panning: channels 0/3 → left, 1/2 → right.
      const isLeft = ci === 0 || ci === 3;
      const dst = isLeft ? outL : outR;
      const data = v.data;
      const dataLen = data.byteLength;
      // Volume scale matches Paula's `1 / (128 * 64)` so downstream NORM_FACTOR
      // and stereo math work without per-mixer fudging.
      const volScale = v.volume * (1 / (128 * 64));
      const dt = v.bytesPerFrame;
      const loopActive = v.loopLengthWords > 1;
      const loopEndBytes = v.loopStartBytes + v.loopLengthWords * 2;
      const sampleEndBytes = v.startOffsetBytes + v.lengthWords * 2;
      let pos = v.posBytes;
      let peak = this.channelPeaks[ci]!;

      for (let j = 0; j < frames; j++) {
        // End-of-region wrap. Once we've crossed the initial region's end we
        // either fold into the loop bounds or stop the voice — same rules PT
        // / Paula apply.
        if (loopActive) {
          if (pos >= loopEndBytes) {
            // Fast-fold for very short loops where dt > loopLen.
            const span = loopEndBytes - v.loopStartBytes;
            pos = v.loopStartBytes + ((pos - v.loopStartBytes) % span);
          } else if (pos >= sampleEndBytes && pos < v.loopStartBytes) {
            // Initial region exhausted but cursor hasn't reached the loop —
            // jump to loop start (one-shot intro pattern).
            pos = v.loopStartBytes;
          }
        } else if (pos >= sampleEndBytes) {
          v.active = false;
          break;
        }

        // Linear interpolation between the integer byte and its neighbour.
        // Edge frames sample 0 outside the data buffer — same behaviour Paula
        // shows when DMA over-reads (the audio just goes silent at the tail).
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = idx >= 0 && idx < dataLen ? data[idx]! : 0;
        const bIdx = idx + 1;
        let b: number;
        if (loopActive && bIdx >= loopEndBytes) {
          // Wrap the second tap into the loop so the join is smooth.
          b = data[v.loopStartBytes] ?? 0;
        } else {
          b = bIdx >= 0 && bIdx < dataLen ? data[bIdx]! : 0;
        }
        const sample = (a + (b - a) * frac) * volScale;
        dst[offset + j] = dst[offset + j]! + sample;
        const av = sample < 0 ? -sample : sample;
        if (av > peak) peak = av;

        pos += dt;
      }

      v.posBytes = pos;
      this.channelPeaks[ci] = peak;
    }
  }

  peakSnapshotAndReset(out: Float32Array): void {
    for (let i = 0; i < PAULA_VOICES; i++) {
      out[i] = this.channelPeaks[i]!;
      this.channelPeaks[i] = 0;
    }
  }
}
