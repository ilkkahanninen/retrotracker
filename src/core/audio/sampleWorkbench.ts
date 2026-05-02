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

export type EffectNode =
  | { kind: 'gain'; params: { gain: number } }
  | { kind: 'normalize' }
  | { kind: 'reverse' }
  | { kind: 'crop'; params: { startFrame: number; endFrame: number } }
  | { kind: 'cut';  params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeIn'; params: { frames: number } }
  | { kind: 'fadeOut'; params: { frames: number } };

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

export function applyReverse(input: WavData): WavData {
  return mapChannels(input, (ch) => {
    const len = ch.length;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = ch[len - 1 - i]!;
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

export function applyFadeIn(input: WavData, frames: number): WavData {
  const n = Math.max(0, Math.floor(frames));
  if (n === 0) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    const ramp = Math.min(n, ch.length);
    for (let i = 0; i < ramp; i++) out[i] = ch[i]! * (i / n);
    for (let i = ramp; i < ch.length; i++) out[i] = ch[i]!;
    return out;
  });
}

export function applyFadeOut(input: WavData, frames: number): WavData {
  const n = Math.max(0, Math.floor(frames));
  if (n === 0) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    const total = ch.length;
    const start = Math.max(0, total - n);
    for (let i = 0; i < start; i++) out[i] = ch[i]!;
    for (let i = start; i < total; i++) {
      const remaining = total - i;
      out[i] = ch[i]! * (remaining / n);
    }
    return out;
  });
}

export function applyEffect(input: WavData, node: EffectNode): WavData {
  switch (node.kind) {
    case 'gain':       return applyGain(input, node.params.gain);
    case 'normalize':  return applyNormalize(input);
    case 'reverse':    return applyReverse(input);
    case 'crop':       return applyCrop(input, node.params.startFrame, node.params.endFrame);
    case 'cut':        return applyCut(input, node.params.startFrame, node.params.endFrame);
    case 'fadeIn':     return applyFadeIn(input, node.params.frames);
    case 'fadeOut':    return applyFadeOut(input, node.params.frames);
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

/** Default-parameter factory for newly-added effects. */
export function defaultEffect(kind: EffectKind, source: WavData): EffectNode {
  const len = source.channels[0]?.length ?? 0;
  switch (kind) {
    case 'gain':      return { kind: 'gain', params: { gain: 1 } };
    case 'normalize': return { kind: 'normalize' };
    case 'reverse':   return { kind: 'reverse' };
    case 'crop':      return { kind: 'crop', params: { startFrame: 0, endFrame: len } };
    // Default Cut is a noop (empty range) — the user fills in start/end
    // either by editing the param fields or, in the common case, by
    // selecting on the waveform and clicking "Cut selection".
    case 'cut':       return { kind: 'cut',  params: { startFrame: 0, endFrame: 0 } };
    case 'fadeIn':    return { kind: 'fadeIn', params: { frames: Math.min(1024, len) } };
    case 'fadeOut':   return { kind: 'fadeOut', params: { frames: Math.min(1024, len) } };
  }
}
