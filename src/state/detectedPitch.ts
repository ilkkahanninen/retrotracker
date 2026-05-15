import { createMemo, type Accessor } from "solid-js";
import type {
  SampleWorkbench,
  XmSampleWorkbench,
} from "../core/audio/sampleWorkbench";
import type { WavData } from "../core/audio/wav";
import {
  detectPitch,
  detectPitchFromWav,
  type PitchResult,
} from "../core/audio/pitchDetect";
import { XM_BASE_HZ } from "../core/audio/xmFreqTable";
import type { XmSample } from "../core/xm/types";

/**
 * Effective sample rate of an XmSample's stored bytes.
 *
 * XM doesn't carry a per-sample rate on disk — it carries `relativeNote`
 * (semitones from C-4) and `finetune` (1/128-semitone units) and uses
 * them at trigger time to derive the Paula playback rate. The "native"
 * rate of the bytes — the rate at which the sample was recorded, given
 * a standard import — is recoverable from those two fields: it's the
 * Hz that playback would produce when triggered at C-4 with the current
 * tuning. The importer auto-sets `relativeNote`/`finetune` so this
 * equals the WAV's original sample rate; for `.xm` files loaded from
 * disk we trust whatever the author tuned.
 *
 * Using this rate (rather than a fixed 8363 Hz) is what lets the pitch
 * detector report the *audible* pitch of the sample as it will sound
 * when triggered — which is what the user is actually tuning against.
 */
export function effectiveXmSampleRate(s: XmSample): number {
  return (
    XM_BASE_HZ * Math.pow(2, s.relativeNote / 12 + s.finetune / (128 * 12))
  );
}

/**
 * Solid memo that runs YIN pitch detection against a workbench's source
 * WAV exactly once per source change. The chain mutates the workbench
 * itself frequently (every slider drag), but `wb.source.wav` is a stable
 * reference until the user reloads / swaps the sample — caching on that
 * identity is what keeps detection off the slider-drag hot path.
 *
 * Returns `null` when the workbench is absent, the source is a chiptune
 * (synthesised — pitch is implicit in the params), or the detector
 * rejects the signal (silence / noise / too short).
 */
export function createDetectedPitch(
  workbench: Accessor<SampleWorkbench | XmSampleWorkbench | null | undefined>,
): Accessor<PitchResult | null> {
  let cachedWav: WavData | null = null;
  let cachedResult: PitchResult | null = null;
  return createMemo<PitchResult | null>(() => {
    const wb = workbench();
    if (!wb || wb.source.kind !== "sampler") {
      cachedWav = null;
      cachedResult = null;
      return null;
    }
    const wav = wb.source.wav;
    if (cachedWav === wav) return cachedResult;
    cachedWav = wav;
    cachedResult = detectPitchFromWav(wav);
    return cachedResult;
  });
}

/**
 * XM-specific variant. Two issues set it apart from the PT factory:
 *
 *   (1) XM workbenches are lazy-created — `getXmWorkbench` returns
 *       undefined for a freshly-loaded `.xm` sample even though the
 *       bytes are sitting right there in the song. We fall back to
 *       analysing `XmSample.data` directly when no workbench exists.
 *
 *   (2) The "sample rate" of XM byte data is not 8363 Hz (the C-4
 *       reference). It's whatever rate produces the right playback at
 *       C-4 given the sample's `relativeNote`/`finetune` — and that's
 *       what the user is actually hearing. So we always derive the
 *       analysis sample rate from the XmSample's tuning fields via
 *       `effectiveXmSampleRate`, whether the audio comes from the
 *       workbench's chain output or from raw bytes.
 *
 * Returns `null` for chiptune mode (synthesised — pitch is implicit in
 * the params) or when no sample / no bytes are available.
 */
export function createDetectedXmPitch(
  workbench: Accessor<XmSampleWorkbench | null | undefined>,
  fallbackSample: Accessor<XmSample | undefined>,
): Accessor<PitchResult | null> {
  let cachedAudioRef: Float32Array | Int8Array | Int16Array | null = null;
  let cachedTuneKey = "";
  let cachedResult: PitchResult | null = null;

  return createMemo<PitchResult | null>(() => {
    const wb = workbench();
    if (wb && wb.source.kind === "chiptune") {
      cachedAudioRef = null;
      cachedTuneKey = "";
      cachedResult = null;
      return null;
    }
    const s = fallbackSample();
    if (!s || s.data.length === 0) {
      cachedAudioRef = null;
      cachedTuneKey = "";
      cachedResult = null;
      return null;
    }
    const sr = effectiveXmSampleRate(s);
    // Tuning key separate from the audio identity: a user nudging
    // relativeNote / finetune doesn't replace the byte buffer but does
    // shift the rate the detector should analyse at.
    const tuneKey = `${s.relativeNote}:${s.finetune}`;
    // Prefer the workbench's float channel — it reflects any chain
    // edits — when available; otherwise convert the raw bytes.
    const audio: Float32Array | null =
      wb && wb.source.kind === "sampler"
        ? (wb.source.wav.channels[0] ?? null)
        : null;
    const audioRef = audio ?? s.data;
    if (cachedAudioRef === audioRef && cachedTuneKey === tuneKey) {
      return cachedResult;
    }
    cachedAudioRef = audioRef;
    cachedTuneKey = tuneKey;
    cachedResult = detectPitch(audio ?? xmSampleToFloat32(s), sr);
    return cachedResult;
  });
}

/** int8/int16 sample bytes → normalised Float32. Same scaling rule as
 *  `xmWorkbenchFromSample`, so the detector sees the identical signal
 *  shape whether we're reading from the workbench WAV or the raw bytes. */
function xmSampleToFloat32(s: XmSample): Float32Array {
  const out = new Float32Array(s.data.length);
  if (s.bits === 8) {
    const src = s.data as Int8Array;
    for (let i = 0; i < src.length; i++) out[i] = src[i]! / 127;
  } else {
    const src = s.data as Int16Array;
    for (let i = 0; i < src.length; i++) out[i] = src[i]! / 32767;
  }
  return out;
}
