/**
 * Shared helpers for WAV → tracker-sample conversion. Both the PT
 * (`core/mod/sampleImport.ts`) and XM (`core/xm/sampleImport.ts`)
 * importers compose these primitives — PT forces 8-bit output, XM
 * supports 8- or 16-bit.
 */

import type { WavData } from "./wav";

/** PT / XM sample-name field is 22 ASCII bytes, null-padded. */
export const SAMPLE_NAME_MAX = 22;

/**
 * Pick a sample name from a filename: strip path/extension, ASCII-clean,
 * truncate. Returns "" when nothing usable is left.
 */
export function deriveSampleName(
  filename: string,
  maxLen: number = SAMPLE_NAME_MAX,
): string {
  const slashAt = Math.max(
    filename.lastIndexOf("/"),
    filename.lastIndexOf("\\"),
  );
  const base = slashAt >= 0 ? filename.slice(slashAt + 1) : filename;
  const dot = base.lastIndexOf(".");
  // dot >= 0 (not > 0) so a leading-dot file like ".wav" yields "", not ".wav".
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[^\x20-\x7e]+/g, "_").trim();
  return cleaned.slice(0, maxLen);
}

/**
 * Mix all channels to mono via equal-weight average. Returns a fresh
 * Float32Array sized to the longest channel, or an empty array for
 * zero-channel input.
 */
export function mixDownToMono(wav: WavData): Float32Array {
  const channels = wav.channels;
  if (channels.length === 0) return new Float32Array(0);
  const frames = channels[0]!.length;
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(frames);
  const nch = channels.length;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
    out[i] = sum / nch;
  }
  return out;
}

/**
 * Quantise a mono Float32 buffer (values in [-1, 1]) to signed integer
 * PCM. The output is symmetric — +1 maps to `peak`, -1 maps to `-peak`,
 * so the lone Int8 value -128 / Int16 -32768 is never produced. Matches
 * what most tools emit for 8/16-bit signed PCM.
 */
export function quantiseToInt(
  samples: Float32Array,
  bits: 8 | 16,
): Int8Array | Int16Array {
  const peak = bits === 8 ? 127 : 32767;
  const Buf = bits === 8 ? Int8Array : Int16Array;
  const out = new Buf(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(c * peak);
  }
  return out;
}
