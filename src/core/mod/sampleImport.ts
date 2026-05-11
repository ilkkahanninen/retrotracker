/**
 * Convert an external audio source (WAV today, IFF/8SVX later) into the shape
 * a ProTracker sample expects: 8-bit signed mono PCM. The output is detached
 * from any sample-rate expectation — PT's pitch comes from period, not from
 * the source's rate, so we just down-convert amplitude and number of channels.
 */

import {
  deriveSampleName,
  mixDownToMono,
  quantiseToInt,
  SAMPLE_NAME_MAX,
} from "../audio/sampleHelpers";
import type { WavData } from "../audio/wav";
import { readWav } from "../audio/wav";

export { deriveSampleName, SAMPLE_NAME_MAX };

export interface ImportedSample {
  /** 8-bit signed mono PCM. Even-byte aligned. */
  data: Int8Array;
  /** Original sample rate in Hz (for UI display only — PT doesn't store it). */
  sourceSampleRate: number;
  /** Suggested name (e.g. derived from filename). 22-char ASCII at most. */
  name: string;
}

/**
 * Mix down channels and quantise to int8. Each Float32 channel is in
 * [-1, 1]; the quantiser clamps before scaling so a slightly-out-of-range
 * source doesn't wrap to the wrong sign at the int8 boundary.
 */
export function wavToInt8Mono(wav: WavData): Int8Array {
  return quantiseToInt(mixDownToMono(wav), 8) as Int8Array;
}

/** Top-level convenience: bytes (the `.wav` file) + filename → ImportedSample. */
export function importWavSample(
  bytes: Uint8Array,
  filename: string,
): ImportedSample {
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
 * `* 127` in the quantiser, so for any byte in [-127, 127] the pipeline
 * (with empty chain and `sampleRate` matching the PT target rate)
 * reproduces the original bytes exactly. The lone value -128 clamps
 * back to -127 — a pre-existing quirk of the pipeline, not introduced
 * here.
 */
export function int8ToWav(data: Int8Array, sampleRate: number): WavData {
  const ch = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) ch[i] = data[i]! / 127;
  return { sampleRate, channels: [ch] };
}
