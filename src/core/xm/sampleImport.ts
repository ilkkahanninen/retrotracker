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
import {
  runXmPipeline,
  xmWorkbenchFromWav,
  type XmSampleWorkbench,
  type XmWorkbenchAlt,
} from "../audio/sampleWorkbench";
import { readWav, type WavData } from "../audio/wav";
import { XM_BASE_HZ, xmC4Rate } from "../audio/xmFreqTable";

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
 * Math: at C-4 trigger in linear mode, playback Hz = `8363 *
 * 2^(relativeNote/12 + step/(16*12))`, where `step` is the finetune in
 * the 1/16-semitone steps FT2 actually resolves (it ignores the low three
 * bits of the stored -128..127 value). Solving for the tuning that
 * produces `targetRate` gives `192 * log2(targetRate / 8363)` steps, split
 * into relativeNote × 16 + step. The stored finetune is `step * 8`, so
 * what the field says is exactly what plays; the worst-case error is half
 * a step, about 3 cents.
 */
export function tuneForSampleRate(
  targetRate: number,
  linear = true,
): {
  relativeNote: number;
  finetune: number;
} {
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    return { relativeNote: 0, finetune: 0 };
  }
  const guess = Math.round(192 * Math.log2(targetRate / XM_BASE_HZ));
  // The formula above is exact for linear periods. The Amiga table's
  // integer periods land a little off it, so there a neighbouring step
  // can be the closer one: ask the replayer's own rate for each and keep
  // the best.
  let best = tuningForSteps(guess);
  if (!linear) {
    let bestError = Infinity;
    for (const steps of [guess - 1, guess, guess + 1]) {
      const tuning = tuningForSteps(steps);
      const rate = xmC4Rate(tuning.relativeNote, tuning.finetune, false);
      if (rate === null) continue;
      const error = Math.abs(Math.log2(rate / targetRate));
      if (error < bestError) {
        bestError = error;
        best = tuning;
      }
    }
  }
  return best;
}

/** Split a tuning in 1/16-semitone steps into the two stored fields. */
function tuningForSteps(steps: number): {
  relativeNote: number;
  finetune: number;
} {
  let relativeNote = Math.round(steps / 16);
  // step lands in [-8, 8] from the round() split, so finetune is within
  // [-64, 64] and needs no carry into relativeNote.
  let finetune = (steps - relativeNote * 16) * 8;
  relativeNote = Math.max(-96, Math.min(95, relativeNote));
  finetune = Math.max(-128, Math.min(127, finetune));
  // `+ 0`: a negative step count that splits evenly would otherwise
  // leave a -0 in the field.
  return { relativeNote: relativeNote + 0, finetune: finetune + 0 };
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

/** A WAV ready to land in an (instrument, sample) slot: the workbench
 *  that keeps the original audio as its source, and the sample rendered
 *  from it. The two must be committed together. */
export interface XmWavImport {
  wb: XmSampleWorkbench;
  sample: XmSample;
}

export interface XmWavImportOptions {
  /** Output bit depth. Default 16, to preserve source fidelity
   *  (including float sources). */
  bits?: 8 | 16;
  /** Volume / panning to carry over from the sample being replaced. */
  keep?: Pick<XmSample, "volume" | "panning">;
  /** Alt stash for the new workbench — the other source kind the slot
   *  had, so the user can still toggle back to it. */
  alt?: XmWorkbenchAlt | null;
}

/**
 * Turn decoded WAV audio into an XM sample, the one way every import
 * path does it (Load WAV, the drop handlers, …):
 *
 * - The workbench's source is the WAV as decoded — every channel, at its
 *   own sample rate — so the pipeline's Mono-mix choice and its Hz-based
 *   filter cutoffs work on the real audio, as they do in PT mode.
 * - The sample bytes are that workbench's pipeline output.
 * - The tuning is derived from the WAV's rate, so C-4 plays it at its
 *   original speed. It is never inherited from a sample being replaced:
 *   that tuning described the old audio's rate, and keeping it is what
 *   made a 44.1 kHz WAV loaded over an untuned sample play ~29 semitones
 *   low.
 */
export function buildXmWavImport(
  wav: WavData,
  name: string,
  linear: boolean,
  opts: XmWavImportOptions = {},
): XmWavImport {
  const base = xmWorkbenchFromWav(wav, name);
  const wb: XmSampleWorkbench = {
    ...base,
    xm: opts.bits ? { ...base.xm, bitDepth: opts.bits } : base.xm,
    alt: opts.alt ?? null,
  };
  const { data, bits } = runXmPipeline(wb);
  const sample: XmSample = {
    ...emptyXmSample(),
    ...(opts.keep
      ? { volume: opts.keep.volume, panning: opts.keep.panning }
      : {}),
    ...tuneForSampleRate(wav.sampleRate, linear),
    name,
    data,
    bits,
    // A fresh import starts without a loop.
    loopStart: 0,
    loopLength: 0,
    loopType: "none",
  };
  return { wb, sample };
}

/**
 * Top-level convenience: WAV bytes + filename → ready-to-drop XmSample.
 * Pass `bits` to force a specific output depth; default is 16-bit to
 * preserve source fidelity (including float sources). Callers that also
 * want the pipeline workbench use `buildXmWavImport`.
 */
export function importWavXmSample(
  bytes: Uint8Array,
  filename: string,
  opts: { bits?: 8 | 16 } = {},
): ImportedXmSample {
  const wav = readWav(bytes);
  const { sample } = buildXmWavImport(
    wav,
    deriveXmSampleName(filename),
    true,
    opts,
  );
  return { sample, sourceSampleRate: wav.sampleRate };
}
