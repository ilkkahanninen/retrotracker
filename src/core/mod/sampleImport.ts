/**
 * Convert an external audio source (WAV today, IFF/8SVX later) into the shape
 * a ProTracker sample expects: 8-bit signed mono PCM. The output is detached
 * from any sample-rate expectation — PT's pitch comes from period, not from
 * the source's rate, so we just down-convert amplitude and number of channels.
 */

import type { WavData } from '../audio/wav';
import { readWav } from '../audio/wav';

export interface ImportedSample {
  /** 8-bit signed mono PCM. Even-byte aligned. */
  data: Int8Array;
  /** Original sample rate in Hz (for UI display only — PT doesn't store it). */
  sourceSampleRate: number;
  /** Suggested name (e.g. derived from filename). 22-char ASCII at most. */
  name: string;
}

/** PT name field is 22 ASCII bytes, null-padded. */
export const SAMPLE_NAME_MAX = 22;

/**
 * Pick a sample name from a filename: strip path/extension, ASCII-clean,
 * truncate to 22 chars. Returns "" when nothing usable is left.
 */
export function deriveSampleName(filename: string): string {
  const slashAt = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = slashAt >= 0 ? filename.slice(slashAt + 1) : filename;
  const dot = base.lastIndexOf('.');
  // dot >= 0 (not > 0) so a leading-dot file like ".wav" yields "", not ".wav".
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const cleaned = stem
    .replace(/[^\x20-\x7e]+/g, '_')
    .trim();
  return cleaned.slice(0, SAMPLE_NAME_MAX);
}

/**
 * Mix down (or pass through) channels and quantise to int8. Each Float32
 * channel is in [-1, 1]; we clamp before scaling so a slightly-out-of-range
 * source doesn't wrap to the wrong sign at the int8 boundary.
 */
export function wavToInt8Mono(wav: WavData): Int8Array {
  const channels = wav.channels;
  if (channels.length === 0) return new Int8Array(0);
  const frames = channels[0]!.length;
  const out = new Int8Array(frames);
  if (channels.length === 1) {
    const c = channels[0]!;
    for (let i = 0; i < frames; i++) out[i] = floatToInt8(c[i]!);
  } else {
    // Average all channels frame-by-frame.
    const nch = channels.length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
      out[i] = floatToInt8(sum / nch);
    }
  }
  return out;
}

function floatToInt8(v: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  // 127 (not 128) so +1 maps to 127 — symmetric range, matches what most
  // tools produce for 8-bit signed PCM.
  return Math.round(c * 127);
}

/** Top-level convenience: bytes (the `.wav` file) + filename → ImportedSample. */
export function importWavSample(bytes: Uint8Array, filename: string): ImportedSample {
  const wav = readWav(bytes);
  return {
    data: wavToInt8Mono(wav),
    sourceSampleRate: wav.sampleRate,
    name: deriveSampleName(filename),
  };
}

/**
 * Wrap an int8 PCM buffer as a single-channel WavData. The reverse of
 * `wavToInt8Mono` for the round-trip case: dividing by 127 inverts the
 * `* 127` in `transformToPt`'s `floatToInt8`, so for any byte in
 * [-127, 127] the pipeline (with empty chain and `sampleRate` matching
 * the PT target rate) reproduces the original bytes exactly. The lone
 * value -128 clamps back to -127 — a pre-existing quirk of the pipeline,
 * not introduced here.
 */
export function int8ToWav(data: Int8Array, sampleRate: number): WavData {
  const ch = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) ch[i] = data[i]! / 127;
  return { sampleRate, channels: [ch] };
}
