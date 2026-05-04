/**
 * Sample workbench — a per-slot, session-only editing pipeline that lives
 * outside the Song.
 *
 *   source → effect chain → PT transformer → Int8Array
 *
 * The source is a `SampleSource` union: today either a loaded WAV (the
 * "Sampler" — kind: 'sampler') or a wavetable synth cycle (kind: 'chiptune').
 * `materializeSource` is the only place that knows how to turn either into a
 * WavData; everything downstream is shape-agnostic.
 *
 * Each effect is a pure `WavData → WavData` function. The terminal PT
 * transformer mixes to mono and quantises to 8-bit signed; its output is
 * written back into `song.samples[slot].data` via `replaceSampleData`.
 *
 * Playback reads the int8 data; it never touches the workbench. That's the
 * boundary: the pipeline shapes the int8, then we hand off to the replayer.
 *
 * Sampler workbenches don't survive a `.mod` save / re-load (their WAV
 * source bytes can be MB-sized, no good fit for localStorage / `.retro`).
 * Chiptune workbenches DO persist — their params are tiny, and the synth is
 * deterministic so re-running the pipeline reproduces the int8 exactly.
 */

import type { WavData } from './wav';
import { readWav } from './wav';
import { deriveSampleName, int8ToWav } from '../mod/sampleImport';
import { PAULA_CLOCK_PAL, PERIOD_TABLE } from '../mod/format';
import {
  type ChiptuneParams,
  defaultChiptuneParams,
  generateChiptuneCycle,
} from './chiptune';
import { applyShaper, type ShaperMode } from './shapers';

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
export type FilterType = 'lowpass' | 'highpass';

export type EffectNode =
  | { kind: 'gain'; params: { gain: number } }
  | { kind: 'normalize' }
  | { kind: 'reverse';  params: { startFrame: number; endFrame: number } }
  | { kind: 'crop';     params: { startFrame: number; endFrame: number } }
  | { kind: 'cut';      params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeIn';   params: { startFrame: number; endFrame: number } }
  | { kind: 'fadeOut';  params: { startFrame: number; endFrame: number } }
  | {
      kind: 'filter';
      params: {
        /** 'lowpass' attenuates above cutoff, 'highpass' attenuates below. */
        type: FilterType;
        /** Cutoff in Hz — clamped to [10, sourceRate/2). */
        cutoff: number;
        /** Resonance / quality factor. ~0.707 ≈ Butterworth (no peak), higher resonates. */
        q: number;
      };
    }
  | {
      kind: 'crossfade';
      params: {
        /** Crossfade window length in source-frame units. */
        length: number;
      };
    }
  | {
      kind: 'shaper';
      params: {
        /** Waveshaper mode — see SHAPER_MODES in shapers.ts. */
        mode: ShaperMode;
        /** Drive / wet-dry blend, 0..1. 0 = bypass, 1 = full effect. */
        amount: number;
      };
    };

export type EffectKind = EffectNode['kind'];

export const EFFECT_KINDS: readonly EffectKind[] = [
  'gain', 'normalize', 'reverse', 'crop', 'cut', 'fadeIn', 'fadeOut', 'filter', 'crossfade', 'shaper',
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
  filter:    'Filter',
  crossfade: 'Crossfade',
  shaper:    'Shaper',
};

/**
 * Loop info threaded through the chain so loop-aware effects (currently
 * just crossfade) can reach the slot's loop boundaries without each effect
 * carrying its own copy. Frames are in the chain's INPUT space (the
 * source's frame count) — `writeWorkbenchToSongPure` derives them by
 * scaling the slot's int8-byte loop fields with `sourceFrames / int8Len`.
 *
 * The mapping is exact only when no length-changing chain effects (crop,
 * cut) ran before the loop-aware effect. With those, the loop frames may
 * point past the current intermediate's end; loop-aware effects clamp.
 */
export interface RunContext {
  loopStartFrame: number;
  loopEndFrame: number;
}

export const FILTER_TYPE_LABELS: Readonly<Record<FilterType, string>> = {
  lowpass:  'Low-pass',
  highpass: 'High-pass',
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

// ─── Sources ──────────────────────────────────────────────────────────────

/**
 * The "front" of the pipeline. Generalised so a slot can be either a
 * traditional WAV-import sampler or a synthesised chiptune cycle. Adding
 * another kind (8SVX/IFF, FM patch, …) means a new variant + a clause in
 * `materializeSource`.
 *
 * The downstream chain + PT transformer don't care which kind produced the
 * WavData — they operate on raw audio.
 */
export type SampleSource =
  | { kind: 'sampler';  wav: WavData; sourceName: string }
  | { kind: 'chiptune'; params: ChiptuneParams };

export type SourceKind = SampleSource['kind'];

export const SOURCE_KINDS: readonly SourceKind[] = ['sampler', 'chiptune'] as const;

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  sampler:  'Sampler',
  chiptune: 'Chiptune',
};

/** Turn a source into the WavData the chain receives. Pure, deterministic. */
export function materializeSource(src: SampleSource): WavData {
  switch (src.kind) {
    case 'sampler':  return src.wav;
    case 'chiptune': return generateChiptuneCycle(src.params);
  }
}

/** Display name for the pipeline header. */
export function sourceDisplayName(src: SampleSource): string {
  switch (src.kind) {
    case 'sampler':  return src.sourceName;
    case 'chiptune': return 'Chiptune';
  }
}

/**
 * Should the slot's loop be set to span the whole result on the first write?
 * Chiptune samples are looping by nature; sampler results aren't.
 */
export function sourceWantsFullLoop(src: SampleSource): boolean {
  return src.kind === 'chiptune';
}

/**
 * Frozen snapshot of one half of a workbench (the "off" side after a
 * source-kind toggle). Holds source + chain + pt so toggling back restores
 * everything the user had on that side, not just the source.
 *
 * `loop` captures the slot's loop fields at stash time so toggling back to
 * a sampler half restores the loop the user had — without it, a sampler
 * with a loop would lose its loop the moment the user flipped to chiptune
 * (chiptune's `sourceWantsFullLoop` rule overwrites the slot's loop) and
 * back. Null means "no specific loop captured" (e.g. the alt was built
 * before the slot existed); restore falls through to default behaviour.
 */
export interface WorkbenchAlt {
  source: SampleSource;
  chain: EffectNode[];
  pt: PtTransformerParams;
  loop: { loopStartWords: number; loopLengthWords: number } | null;
}

export interface SampleWorkbench {
  /** Source feeding the chain — sampler (WAV) or chiptune (synth). */
  source: SampleSource;
  /** Effect chain, runs left-to-right. */
  chain: EffectNode[];
  /** Always-present terminal node. */
  pt: PtTransformerParams;
  /**
   * Stash of the workbench as it stood before the last kind-switch, so the
   * user can flip Sampler ↔ Chiptune and get back the WAV / chain / pt they
   * had on the other side. The stash is always the OPPOSITE kind to
   * `source` (when non-null), since a same-kind toggle is a no-op.
   *
   * Session-only: never round-trips through `.retro`. Reloading a project
   * restores `source` (chiptune persists; sampler doesn't) but not the alt.
   */
  alt: WorkbenchAlt | null;
}

/**
 * Pull the active half of a workbench into an alt-stash record. `loop`
 * (the slot's current loopStart/loopLength at stash time) is stored
 * alongside so restoring this alt later puts the loop back to where the
 * user had it — chiptune's full-loop rule would otherwise have erased it.
 */
export function workbenchToAlt(
  wb: SampleWorkbench,
  loop: { loopStartWords: number; loopLengthWords: number } | null = null,
): WorkbenchAlt {
  return { source: wb.source, chain: wb.chain, pt: wb.pt, loop };
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

/**
 * RBJ-cookbook biquad filter applied per-channel in Direct Form I. The
 * coefficients are baked once from `(type, cutoff, q, sampleRate)`; each
 * channel runs its own pair of unit-delay states so cross-channel content
 * can't leak.
 *
 * Cutoff is clamped to (10, Nyquist - 1) Hz; Q to (0.05, 30). At Q=0.707
 * the response is Butterworth (no resonant peak); higher Q rings near
 * the cutoff. Out-of-range params don't blow up — they just clamp to a
 * sane edge.
 */
export function applyFilter(
  input: WavData,
  type: FilterType,
  cutoff: number,
  q: number,
): WavData {
  const sr = input.sampleRate;
  const f0 = Math.max(10, Math.min(sr * 0.5 - 1, cutoff));
  const Q = Math.max(0.05, Math.min(30, q));

  const w0 = (2 * Math.PI * f0) / sr;
  const cosW = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  // RBJ cookbook coefficients (https://www.w3.org/TR/audio-eq-cookbook/).
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cosW) * 0.5;
    b1 =  1 - cosW;
    b2 = (1 - cosW) * 0.5;
  } else {
    // highpass
    b0 =  (1 + cosW) * 0.5;
    b1 = -(1 + cosW);
    b2 =  (1 + cosW) * 0.5;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  // Normalise so a0 = 1; saves a divide per sample.
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
  const na1 = a1 / a0, na2 = a2 / a0;

  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const x0 = ch[i]!;
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return out;
  });
}

/**
 * FT2-style loop crossfade. Replaces the last `length` frames of the loop
 * with a fade between the original loop tail (fading out) and the audio
 * just before `loopStart` (fading in). At the wrap point (`loopEnd-1`),
 * the audio has fully transitioned to "what comes just before loopStart",
 * so when DMA wraps from `loopEnd-1` to `loopStart` the next frame is the
 * naturally-adjacent original sample — no click.
 *
 * Length is clamped to fit the available room: at most `loopStart` (need
 * that many pre-loop samples), at most `loopEnd - loopStart` (must fit
 * inside the loop). With either constraint at zero the effect is a no-op.
 */
export function applyCrossfade(
  input: WavData,
  length: number,
  loopStartFrame: number,
  loopEndFrame: number,
): WavData {
  const len = input.channels[0]?.length ?? 0;
  const ls = Math.max(0, Math.min(len, Math.floor(loopStartFrame)));
  const le = Math.max(ls, Math.min(len, Math.floor(loopEndFrame)));
  const requested = Math.max(0, Math.floor(length));
  // Available room: pre-loop tail length AND loop length. We fade across
  // min of the three so the indices stay in-bounds and the loop content
  // outside the fade is preserved.
  const usable = Math.min(requested, ls, le - ls);
  if (usable <= 0) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    out.set(ch);
    for (let i = 0; i < usable; i++) {
      // t = 0 at the start of the fade window (audio still close to
      // original loop end); t = 1 at the very last frame of the loop
      // (audio matches `ch[ls - 1]`, so the wrap to `ch[ls]` is smooth).
      const t = usable > 1 ? i / (usable - 1) : 1;
      const targetIdx = le - usable + i;
      const sourceIdx = ls - usable + i;
      out[targetIdx] = (1 - t) * ch[targetIdx]! + t * ch[sourceIdx]!;
    }
    return out;
  });
}

/**
 * Per-sample waveshaper across every channel. Whole-input only — there's
 * no range param. `mode === 'none'` is a fast pass-through, matching the
 * shaper-stage contract from chiptune.
 */
export function applyShaperEffect(input: WavData, mode: ShaperMode, amount: number): WavData {
  if (mode === 'none' || amount === 0) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = applyShaper(ch[i]!, mode, amount);
    return out;
  });
}

export function applyEffect(
  input: WavData,
  node: EffectNode,
  ctx?: RunContext | null,
): WavData {
  switch (node.kind) {
    case 'gain':       return applyGain(input, node.params.gain);
    case 'normalize':  return applyNormalize(input);
    case 'reverse':    return applyReverse(input, node.params.startFrame, node.params.endFrame);
    case 'crop':       return applyCrop(input, node.params.startFrame, node.params.endFrame);
    case 'cut':        return applyCut(input, node.params.startFrame, node.params.endFrame);
    case 'fadeIn':     return applyFadeIn(input, node.params.startFrame, node.params.endFrame);
    case 'fadeOut':    return applyFadeOut(input, node.params.startFrame, node.params.endFrame);
    case 'filter':     return applyFilter(input, node.params.type, node.params.cutoff, node.params.q);
    case 'shaper':     return applyShaperEffect(input, node.params.mode, node.params.amount);
    case 'crossfade':
      // Loop info comes from the run context — without it (slot has no
      // loop, or the chain ran outside `writeWorkbenchToSongPure`) the
      // effect is a pass-through.
      if (!ctx) return input;
      return applyCrossfade(input, node.params.length, ctx.loopStartFrame, ctx.loopEndFrame);
  }
}

export function runChain(
  source: WavData,
  chain: EffectNode[],
  ctx?: RunContext | null,
): WavData {
  let cur = source;
  for (const node of chain) cur = applyEffect(cur, node, ctx);
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
export function runPipeline(
  workbench: SampleWorkbench,
  ctx?: RunContext | null,
): Int8Array {
  return transformToPt(
    runChain(materializeSource(workbench.source), workbench.chain, ctx),
    workbench.pt,
  );
}

// ─── Construction ─────────────────────────────────────────────────────────

/** Decode a WAV file into a fresh workbench with an empty effect chain. */
export function workbenchFromWav(bytes: Uint8Array, filename: string): SampleWorkbench {
  return workbenchFromWavData(readWav(bytes), deriveSampleName(filename) || filename);
}

/**
 * Wrap an existing PT sample's int8 bytes as a Sampler workbench. Used
 * when loading a `.mod` so every populated slot gets a chain UI without
 * the user having to re-import. The WavData's `sampleRate` is set to the
 * C-2 target rate so the PT transformer's resampler short-circuits — an
 * empty-chain pipeline run reproduces the input bytes (modulo the lone
 * -128 → -127 quirk in `floatToInt8`). We don't auto-write through the
 * pipeline either, so the slot's int8 stays bit-identical until the user
 * actually edits the chain.
 */
export function workbenchFromInt8(data: Int8Array, sourceName: string): SampleWorkbench {
  const sampleRate = rateForTargetNote(DEFAULT_TARGET_NOTE) ?? 22050;
  return {
    source: { kind: 'sampler', wav: int8ToWav(data, sampleRate), sourceName },
    chain: [],
    pt: { monoMix: 'average', targetNote: DEFAULT_TARGET_NOTE },
    alt: null,
  };
}

/**
 * Same as `workbenchFromWav` but for already-decoded `WavData`. Used by the
 * `.retro` restore path, where the persistence layer has already decoded the
 * WAV bytes — re-running `readWav` would be wasted work and would also lose
 * the source name we stored separately.
 */
export function workbenchFromWavData(wav: WavData, sourceName: string): SampleWorkbench {
  return {
    source: { kind: 'sampler', wav, sourceName },
    chain: [],
    // Default to C-2: when the user triggers C-2 in a pattern, the sample
    // plays at its original speed. They can change the target (or set null
    // to disable resampling entirely) from the Effects panel.
    pt: { monoMix: 'average', targetNote: DEFAULT_TARGET_NOTE },
    alt: null,
  };
}

/**
 * Build a fresh chiptune workbench. Uses `defaultChiptuneParams` and disables
 * PT resampling — pitch comes from the cycle length applied to the PT period
 * at playback time, not from rate conversion.
 */
export function workbenchFromChiptune(
  params: ChiptuneParams = defaultChiptuneParams(),
): SampleWorkbench {
  return {
    source: { kind: 'chiptune', params },
    chain: [],
    pt: { monoMix: 'average', targetNote: null },
    alt: null,
  };
}

/**
 * "Empty Sampler" workbench — a sampler whose source has no audio yet,
 * waiting for the user to Load WAV. Used when toggling Chiptune → Sampler
 * on a slot that has no remembered WAV: the workbench's view-mode flips to
 * Sampler, the chiptune side is preserved in `alt`, and the Load WAV
 * button becomes the path to actually populate the source.
 *
 * Materialised source is an empty mono WavData; the pipeline emits zero
 * bytes, which `replaceSampleData` collapses to a 0-length sample slot.
 */
export function emptySamplerWorkbench(): SampleWorkbench {
  return {
    source: {
      kind: 'sampler',
      wav: { sampleRate: 22050, channels: [new Float32Array(0)] },
      sourceName: '',
    },
    chain: [],
    pt: { monoMix: 'average', targetNote: DEFAULT_TARGET_NOTE },
    alt: null,
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
    // 1 kHz / Q=0.707 — Butterworth-flat low-pass. Audible but tame
    // default that gives the user something to hear when they dial Q up
    // or sweep cutoff.
    case 'filter':    return { kind: 'filter',  params: { type: 'lowpass', cutoff: 1000, q: 0.707 } };
    // Default crossfade window: a small fraction of the chain output, capped
    // at 4096 frames so it stays musical on long samples and tiny on short
    // ones. The actual cap is tightened at apply time by `applyCrossfade`
    // (≤ loopStart and ≤ loop length).
    case 'crossfade': return { kind: 'crossfade', params: { length: Math.min(4096, Math.max(1, Math.floor(len / 16))) } };
    // Soft clip at half-drive — audible without being aggressive, gives the
    // user something to hear immediately. They can pick a different mode or
    // dial drive from the param row.
    case 'shaper':    return { kind: 'shaper',    params: { mode: 'softClip', amount: 0.5 } };
  }
}
