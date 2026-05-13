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

import {
  deriveSampleName,
  mixDownToMono,
  quantiseToInt,
  SAMPLE_NAME_MAX,
} from "../audio/sampleHelpers";
import { readWav, type WavData } from "../audio/wav";

import { emptyXmSample } from "./format";
import type { XmSample } from "./types";

/** XM sample-name field is 22 ASCII bytes. Mirrors PT's `SAMPLE_NAME_MAX`. */
export const XM_SAMPLE_NAME_MAX = SAMPLE_NAME_MAX;

export interface ImportedXmSample {
  sample: XmSample;
  /** Original sample rate in Hz — UI display only; XM doesn't store it. */
  sourceSampleRate: number;
}

/** Filename → short ASCII sample name (22 chars max). */
export function deriveXmSampleName(filename: string): string {
  return deriveSampleName(filename, XM_SAMPLE_NAME_MAX);
}

/**
 * Mix down channels and quantise to the requested bit depth. The downmix
 * is a simple equal-weight average, identical to the PT importer.
 */
export function wavToXmSampleData(
  wav: WavData,
  bits: 8 | 16,
): Int8Array | Int16Array {
  return quantiseToInt(mixDownToMono(wav), bits);
}

/**
 * Top-level convenience: WAV bytes + filename → ready-to-drop XmSample.
 * Pass `bits` to force a specific output depth; default is 16-bit to
 * preserve source fidelity (including float sources).
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
