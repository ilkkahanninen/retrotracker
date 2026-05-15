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
import { XM_BASE_HZ } from "../audio/xmFreqTable";

import { emptyXmSample } from "./format";
import type { XmSample } from "./types";

/**
 * FT2 doesn't store a per-sample sample rate on disk; it stores
 * `relativeNote` (semitones from C-4) and `finetune` (-128..127, 128
 * units per semitone) and reads them at trigger time to derive the
 * Paula playback rate. The standard import convention — what ft2-clone,
 * libxmp, and OpenMPT all do — is to auto-set these so that triggering
 * the sample at C-4 plays the data back at its original sample rate.
 *
 * Without this, a 44.1 kHz WAV plays back at the C-4 default rate of
 * 8363 Hz, i.e. ~28 semitones too low — a sample labelled "E4" would
 * sound like B1.
 *
 * Math: at C-4 trigger, playback Hz = `8363 * 2^(relativeNote/12 +
 * finetune/(128*12))`. Solving for tuning that produces `targetRate`
 * gives `total = 1536 * log2(targetRate / 8363)` 1/128-semitone units,
 * then split into relativeNote × 128 + finetune.
 */
export function tuneForSampleRate(targetRate: number): {
  relativeNote: number;
  finetune: number;
} {
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    return { relativeNote: 0, finetune: 0 };
  }
  const total = Math.round(1536 * Math.log2(targetRate / XM_BASE_HZ));
  let relativeNote = Math.round(total / 128);
  let finetune = total - relativeNote * 128;
  // finetune lands in [-64, 64] from the round() split; clamp the pair
  // to the format's storage range so downstream writers don't truncate.
  if (finetune > 127) {
    relativeNote += 1;
    finetune -= 128;
  } else if (finetune < -128) {
    relativeNote -= 1;
    finetune += 128;
  }
  relativeNote = Math.max(-96, Math.min(95, relativeNote));
  finetune = Math.max(-128, Math.min(127, finetune));
  return { relativeNote, finetune };
}

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
  // Auto-tune so triggering at C-4 plays the sample back at the WAV's
  // original sample rate — see `tuneForSampleRate` for the rationale.
  const { relativeNote, finetune } = tuneForSampleRate(wav.sampleRate);
  const sample: XmSample = {
    ...emptyXmSample(),
    name: deriveXmSampleName(filename),
    data,
    bits,
    relativeNote,
    finetune,
    // `emptyXmSample` defaults to no loop; that's the right starting
    // point for a fresh import.
    loopLength: 0,
    loopType: "none",
  };
  return { sample, sourceSampleRate: wav.sampleRate };
}
