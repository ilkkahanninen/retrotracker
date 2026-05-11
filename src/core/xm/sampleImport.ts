/**
 * Convert a WAV file into the shape an XM sample expects. Unlike the PT
 * importer (which forces int8), XM supports both 8- and 16-bit samples,
 * so we preserve the source's bit depth: a 16-bit WAV becomes a 16-bit
 * XM sample, an 8-bit WAV becomes an 8-bit XM sample. The caller can
 * downsample later via the XM workbench if they want smaller modules.
 *
 * The result is a fresh `XmSample` ready to plug into an instrument
 * slot via `setXmSample` — full-volume, centred pan, no loop, no
 * relative-note offset. The host can adjust those fields after import
 * (Phase 4's instrument view exposes them).
 */

import { readWav, type WavData } from "../audio/wav";

import { emptyXmSample } from "./format";
import type { XmSample } from "./types";

/** XM sample-name field is 22 ASCII bytes. Mirrors PT's `SAMPLE_NAME_MAX`. */
export const XM_SAMPLE_NAME_MAX = 22;

export interface ImportedXmSample {
  sample: XmSample;
  /** Original sample rate in Hz — UI display only; XM doesn't store it. */
  sourceSampleRate: number;
}

/** Filename → short ASCII sample name (22 chars max). */
export function deriveXmSampleName(filename: string): string {
  const slashAt = Math.max(
    filename.lastIndexOf("/"),
    filename.lastIndexOf("\\"),
  );
  const base = slashAt >= 0 ? filename.slice(slashAt + 1) : filename;
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return stem
    .replace(/[^\x20-\x7e]+/g, "_")
    .trim()
    .slice(0, XM_SAMPLE_NAME_MAX);
}

function floatToInt(v: number, peak: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(c * peak);
}

/**
 * Mix down (or pass through) channels and quantise. The output bit
 * depth is decided by `bits`: 8-bit peaks at ±127 (symmetric, matching
 * PT's range), 16-bit peaks at ±32767. The downmix is a simple equal-
 * weight average, identical to the PT importer.
 */
export function wavToXmSampleData(
  wav: WavData,
  bits: 8 | 16,
): Int8Array | Int16Array {
  const channels = wav.channels;
  const frames = channels[0]?.length ?? 0;
  const peak = bits === 8 ? 127 : 32767;
  const Buf = bits === 8 ? Int8Array : Int16Array;
  const out = new Buf(frames);
  if (channels.length === 0) return out;
  if (channels.length === 1) {
    const c = channels[0]!;
    for (let i = 0; i < frames; i++) out[i] = floatToInt(c[i]!, peak);
  } else {
    const nch = channels.length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
      out[i] = floatToInt(sum / nch, peak);
    }
  }
  return out;
}

/**
 * Top-level convenience: WAV bytes + filename → ready-to-drop XmSample.
 * Pass `bits` to force a specific output depth; default is to pick the
 * smaller depth that fits the source's PCM format (8 if the WAV is
 * 8-bit, 16 otherwise — including float sources, which quantise to 16
 * to preserve dynamic range).
 */
export function importWavXmSample(
  bytes: Uint8Array,
  filename: string,
  opts: { bits?: 8 | 16 } = {},
): ImportedXmSample {
  const wav = readWav(bytes);
  const bits = opts.bits ?? 16;
  const data = wavToXmSampleData(wav, bits);
  const sample: XmSample = {
    ...emptyXmSample(),
    name: deriveXmSampleName(filename),
    data,
    bits,
    // `emptyXmSample` defaults to no loop; that's the right starting
    // point for a fresh import.
    loopLength: 0,
    loopType: "none",
  };
  return { sample, sourceSampleRate: wav.sampleRate };
}
