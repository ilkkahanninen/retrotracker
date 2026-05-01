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

// ─── Effect node types ───────────────────────────────────────────────────

export type EffectNode =
  | { kind: 'gain'; params: { gain: number } }
  | { kind: 'normalize' }
  | { kind: 'reverse' }
  | { kind: 'crop'; params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeIn'; params: { frames: number } }
  | { kind: 'fadeOut'; params: { frames: number } };

export type EffectKind = EffectNode['kind'];

export const EFFECT_KINDS: readonly EffectKind[] = [
  'gain', 'normalize', 'reverse', 'crop', 'fadeIn', 'fadeOut',
] as const;

/** Human-readable names for the picker UI. */
export const EFFECT_LABELS: Readonly<Record<EffectKind, string>> = {
  gain:      'Gain',
  normalize: 'Normalize',
  reverse:   'Reverse',
  crop:      'Crop',
  fadeIn:    'Fade in',
  fadeOut:   'Fade out',
};

export type MonoMix = 'average' | 'left' | 'right';

export interface PtTransformerParams {
  monoMix: MonoMix;
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
    pt: { monoMix: 'average' },
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
    case 'fadeIn':    return { kind: 'fadeIn', params: { frames: Math.min(1024, len) } };
    case 'fadeOut':   return { kind: 'fadeOut', params: { frames: Math.min(1024, len) } };
  }
}
