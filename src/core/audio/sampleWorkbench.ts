/**
 * Sample workbench — a per-slot, session-only editing pipeline that lives
 * outside the Song.
 *
 *   source (Float32 WavData) → effect chain → PT transformer → Int8Array
 *
 * Each effect is a pure `WavData → WavData` function. The terminal PT
 * transformer mixes to mono and quantises to 8-bit signed; its output is
 * written back into `song.samples[slot].data` via `replaceSampleData`.
 *
 * Playback reads the int8 data; it never touches the workbench. That's the
 * boundary: the pipeline shapes the int8, then we hand off to the replayer.
 *
 * Workbenches don't survive a `.mod` save / re-load — when the user opens
 * a saved file, the slots have only the int8 result, not the recipe to
 * re-derive it. A future project file could persist the chain.
 */

import type { WavData } from './wav';
import { readWav } from './wav';
import { deriveSampleName } from '../mod/sampleImport';
import { PAULA_CLOCK_PAL, PERIOD_TABLE } from '../mod/format';

/** PT note slot for "C-2" — the conventional default target for fresh imports. */
export const DEFAULT_TARGET_NOTE = 12;

// ─── Effect node types ───────────────────────────────────────────────────

/**
 * Range-aware effects (reverse, fadeIn, fadeOut, crop, cut) carry a
 * [startFrame, endFrame) over the chain's input — their per-effect input is
 * the previous chain stage's output, NOT the source. Outside the range, the
 * audio passes through unchanged: a fadeIn over the selection's frames doesn't
 * silence the rest of the sample, it ramps within the selection only.
 *
 * gain / normalize don't take a range — they apply to the whole input.
 */
export type EffectNode =
  | { kind: 'gain'; params: { gain: number } }
  | { kind: 'normalize' }
  | { kind: 'reverse';  params: { startFrame: number; endFrame: number } }
  | { kind: 'crop';     params: { startFrame: number; endFrame: number } }
  | { kind: 'cut';      params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeIn';   params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeOut';  params: { startFrame: number; endFrame: number } };

export type EffectKind = EffectNode['kind'];

export const EFFECT_KINDS: readonly EffectKind[] = [
  'gain', 'normalize', 'reverse', 'crop', 'cut', 'fadeIn', 'fadeOut',
] as const;

/** Human-readable names for the picker UI. */
export const EFFECT_LABELS: Readonly<Record<EffectKind, string>> = {
  gain:      'Gain',
  normalize: 'Normalize',
  reverse:   'Reverse',
  crop:      'Crop',
  cut:       'Cut',
  fadeIn:    'Fade in',
  fadeOut:   'Fade out',
};

export type MonoMix = 'average' | 'left' | 'right';

export interface PtTransformerParams {
  monoMix: MonoMix;
  /**
   * PT note slot (0..35, where 0 = C-1, 12 = C-2, 24 = C-3, 35 = B-3) at
   * which the sample should play at its original speed. The transformer
   * resamples the mono signal so its rate equals what PT's Paula reads at
   * that note's period — i.e. triggering this note in a pattern plays the
   * source at the rate it was recorded.
   *
   * `null` disables resampling: the int8 data carries the source's original
   * rate, and PT will play it slowed (typically way down) when you trigger
   * a note in the standard 113..856 period range.
   */
  targetNote: number | null;
}

export interface SampleWorkbench {
  /** Original loaded audio at original rate / channel count. Never mutated. */
  source: WavData;
  /** Display name (typically derived from the loaded WAV's filename). */
  sourceName: string;
  /** Effect chain, runs left-to-right. */
  chain: EffectNode[];
  /** Always-present terminal node. */
  pt: PtTransformerParams;
}

// ─── Effects ──────────────────────────────────────────────────────────────

function mapChannels(input: WavData, fn: (ch: Float32Array) => Float32Array): WavData {
  return { sampleRate: input.sampleRate, channels: input.channels.map(fn) };
}

export function applyGain(input: WavData, gain: number): WavData {
  if (gain === 1) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i]! * gain;
    return out;
  });
}

export function applyNormalize(input: WavData): WavData {
  let peak = 0;
  for (const ch of input.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]!);
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return input; // silence
  return applyGain(input, 1 / peak);
}

/**
 * Reverse the frames in `[startFrame, endFrame)`. Frames outside that range
 * pass through untouched, so the effect only flips the selected slice — the
 * tail still plays forward, the head still plays forward, only the middle is
 * mirrored.
 */
export function applyReverse(input: WavData, startFrame: number, endFrame: number): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (e - s < 2) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < s; i++) out[i] = ch[i]!;
    for (let i = s; i < e; i++) out[i] = ch[s + (e - 1 - i)]!;
    for (let i = e; i < ch.length; i++) out[i] = ch[i]!;
    return out;
  });
}

/** Slice frames in [startFrame, endFrame). Indices are clamped to the source range. */
export function applyCrop(input: WavData, startFrame: number, endFrame: number): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (s === 0 && e === len) return input;
  return mapChannels(input, (ch) => ch.slice(s, e));
}

/**
 * Remove frames in [startFrame, endFrame) and concatenate what's left.
 * The inverse of crop: crop keeps the selection, cut keeps the rest.
 */
export function applyCut(input: WavData, startFrame: number, endFrame: number): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (s === e) return input; // empty cut → noop
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length - (e - s));
    out.set(ch.subarray(0, s), 0);
    out.set(ch.subarray(e), s);
    return out;
  });
}

/**
 * Linear ramp from gain 0 → 1 over `[startFrame, endFrame)`. Frames outside
 * the range are left untouched (the effect only modulates within the
 * selection — it does NOT silence the tail or head). With start=0 and end=N
 * you get a classic head-fade equivalent to the old `frames=N` form.
 */
export function applyFadeIn(input: WavData, startFrame: number, endFrame: number): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (e <= s) return input;
  const span = e - s;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < s; i++) out[i] = ch[i]!;
    for (let i = s; i < e; i++) out[i] = ch[i]! * ((i - s) / span);
    for (let i = e; i < ch.length; i++) out[i] = ch[i]!;
    return out;
  });
}

/**
 * Linear ramp from gain 1 → 0 over `[startFrame, endFrame)`. Frames outside
 * the range are left untouched (the head plays at full volume, anything
 * after the fade also plays at full volume — the effect only acts within
 * the selection). With start=len-N and end=len you get a classic tail-fade
 * equivalent to the old `frames=N` form.
 */
export function applyFadeOut(input: WavData, startFrame: number, endFrame: number): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (e <= s) return input;
  const span = e - s;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < s; i++) out[i] = ch[i]!;
    for (let i = s; i < e; i++) out[i] = ch[i]! * (1 - (i - s) / span);
    for (let i = e; i < ch.length; i++) out[i] = ch[i]!;
    return out;
  });
}

export function applyEffect(input: WavData, node: EffectNode): WavData {
  switch (node.kind) {
    case 'gain':       return applyGain(input, node.params.gain);
    case 'normalize':  return applyNormalize(input);
    case 'reverse':    return applyReverse(input, node.params.startFrame, node.params.endFrame);
    case 'crop':       return applyCrop(input, node.params.startFrame, node.params.endFrame);
    case 'cut':        return applyCut(input, node.params.startFrame, node.params.endFrame);
    case 'fadeIn':     return applyFadeIn(input, node.params.startFrame, node.params.endFrame);
    case 'fadeOut':    return applyFadeOut(input, node.params.startFrame, node.params.endFrame);
  }
}

export function runChain(source: WavData, chain: EffectNode[]): WavData {
  let cur = source;
  for (const node of chain) cur = applyEffect(cur, node);
  return cur;
}

// ─── PT transformer ───────────────────────────────────────────────────────

function averageChannels(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const len = channels[0]!.length;
  const nch = channels.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
    out[i] = sum / nch;
  }
  return out;
}

function floatToInt8(buf: Float32Array): Int8Array {
  const out = new Int8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(c * 127);
  }
  return out;
}

/**
 * Linear-interpolation resampler. Cheap, mildly aliasing on heavy
 * downsamples — fine for tracker work, where 8-bit quantisation dominates
 * the noise floor anyway. Output length is rounded so the duration stays
 * as close to the source as the integer-frame target allows; non-empty
 * inputs always produce at least one output frame.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0) return input;
  if (Math.abs(fromRate - toRate) < 1e-3) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Convert a PT note slot (0..35) into the Paula playback rate it produces
 * at finetune 0. We resample the source to this rate so the sample plays at
 * its original speed when this note is triggered.
 */
export function rateForTargetNote(noteIndex: number): number | null {
  const period = PERIOD_TABLE[0]?.[noteIndex];
  if (!period || period <= 0) return null;
  // PAULA_CLOCK_PAL is the doubled CPU clock; PT divides by (period * 2).
  return (PAULA_CLOCK_PAL / 2) / period;
}

export function transformToPt(audio: WavData, pt: PtTransformerParams): Int8Array {
  let mono: Float32Array;
  if (audio.channels.length === 0) {
    return new Int8Array(0);
  } else if (audio.channels.length === 1) {
    mono = audio.channels[0]!;
  } else if (pt.monoMix === 'left') {
    mono = audio.channels[0]!;
  } else if (pt.monoMix === 'right') {
    mono = audio.channels[1] ?? audio.channels[0]!;
  } else {
    mono = averageChannels(audio.channels);
  }

  // Resample to the rate PT will play this note at, so the user gets the
  // source at original speed when triggering that note in a pattern.
  if (pt.targetNote !== null) {
    const targetRate = rateForTargetNote(pt.targetNote);
    if (targetRate !== null) mono = resampleLinear(mono, audio.sampleRate, targetRate);
  }

  return floatToInt8(mono);
}

/** End-to-end: source → chain → PT transformer → Int8. */
export function runPipeline(workbench: SampleWorkbench): Int8Array {
  return transformToPt(runChain(workbench.source, workbench.chain), workbench.pt);
}

// ─── Construction ─────────────────────────────────────────────────────────

/** Decode a WAV file into a fresh workbench with an empty effect chain. */
export function workbenchFromWav(bytes: Uint8Array, filename: string): SampleWorkbench {
  return {
    source: readWav(bytes),
    sourceName: deriveSampleName(filename) || filename,
    chain: [],
    // Default to C-2: when the user triggers C-2 in a pattern, the sample
    // plays at its original speed. They can change the target (or set null
    // to disable resampling entirely) from the Effects panel.
    pt: { monoMix: 'average', targetNote: DEFAULT_TARGET_NOTE },
  };
}

/**
 * Default-parameter factory for newly-added effects. `input` is the WavData
 * the new effect will receive — i.e. the chain output up to this point, NOT
 * the workbench source. That way an effect appended after a crop gets
 * defaults sized to the cropped length, not the original source length.
 */
export function defaultEffect(kind: EffectKind, input: WavData): EffectNode {
  const len = input.channels[0]?.length ?? 0;
  switch (kind) {
    case 'gain':      return { kind: 'gain', params: { gain: 1 } };
    case 'normalize': return { kind: 'normalize' };
    case 'reverse':   return { kind: 'reverse', params: { startFrame: 0, endFrame: len } };
    case 'crop':      return { kind: 'crop',    params: { startFrame: 0, endFrame: len } };
    // Default Cut is a noop (empty range) — the user fills in start/end
    // either by editing the param fields or, in the common case, by
    // selecting on the waveform and clicking "Cut".
    case 'cut':       return { kind: 'cut',     params: { startFrame: 0, endFrame: 0 } };
    case 'fadeIn':    return { kind: 'fadeIn',  params: { startFrame: 0, endFrame: Math.min(1024, len) } };
    case 'fadeOut':   return { kind: 'fadeOut', params: { startFrame: Math.max(0, len - 1024), endFrame: len } };
  }
}
