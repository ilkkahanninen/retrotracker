/**
 * Chiptune wavetable synth — produces a single-cycle WavData that the
 * existing sample workbench feeds through the same chain + PT transformer
 * the WAV importer uses. Pitch comes from the PT period applied to the
 * cycle length at playback time, so the cycle is the whole sample (fully
 * looped) and we set `pt.targetNote = null` so the resampler is a no-op.
 *
 * Two oscillators with continuous shape morph (sine→triangle→square→saw)
 * and a phase-split parameter that warps where the cycle's midpoint lands.
 * Combine modes cover the usual chiptune territory: sum / morph / ring /
 * AM / FM / min / max / xor (8-bit signed).
 */
import type { WavData } from './wav';
import { PAULA_CLOCK_PAL, PERIOD_TABLE } from '../mod/format';

// ─── Types ───────────────────────────────────────────────────────────────

export interface Oscillator {
  /**
   * Continuous shape index in [0, 3]. Integer values land on a pure shape
   * (0=sine, 1=triangle, 2=square, 3=saw); fractional values linearly blend
   * the two adjacent shapes.
   */
  shapeIndex: number;
  /**
   * Fraction of the cycle where the warped phase reaches 0.5 — the "first
   * half" duration relative to the whole cycle. 0.5 is a no-op linear ramp;
   * smaller values compress the first half (PWM on square, leaning ramp on
   * triangle, asymmetric sine).
   */
  phaseSplit: number;
}

export type CombineMode =
  | 'sum'    // o1 + amount · o2  (additive, can clip)
  | 'morph'  // (1-amount)·o1 + amount·o2  (level-preserving crossfade)
  | 'ring'  // (1-amount)·o1 + amount·(o1·o2)  (ring modulation)
  | 'am'    // o1 · (1 + amount · o2)  (amplitude modulation)
  | 'fm'    // o1 with phase modulated by amount · o2
  | 'min'   // (1-amount)·o1 + amount·min(o1,o2)
  | 'max'   // (1-amount)·o1 + amount·max(o1,o2)
  | 'xor';  // 8-bit signed XOR, blended with o1 by amount

export const COMBINE_MODES: readonly CombineMode[] = [
  'sum', 'morph', 'ring', 'am', 'fm', 'min', 'max', 'xor',
] as const;

export const COMBINE_LABELS: Readonly<Record<CombineMode, string>> = {
  sum:   'Sum',
  morph: 'Morph',
  ring:  'Ring',
  am:    'AM',
  fm:    'FM',
  min:   'Min',
  max:   'Max',
  xor:   'XOR',
};

export interface ChiptuneParams {
  /** Even, 8..256. Determines how many int8 samples one cycle takes. */
  cycleFrames: number;
  /** Final scale, 0..1. */
  amplitude: number;
  osc1: Oscillator;
  osc2: Oscillator;
  combineMode: CombineMode;
  /** 0..1 (or 0..2 for FM, where it doubles as modulation depth in radians). */
  combineAmount: number;
}

export const CYCLE_FRAMES_MIN = 8;
export const CYCLE_FRAMES_MAX = 256;
export const SHAPE_INDEX_MIN = 0;
export const SHAPE_INDEX_MAX = 3;
export const PHASE_SPLIT_MIN = 0.05;
export const PHASE_SPLIT_MAX = 0.95;

/**
 * Cycle-frame values that the synth snaps to — each step is an octave.
 * Heard pitch = playbackRate / cycleFrames, so doubling the cycle length
 * drops the perceived pitch by one octave. Restricting cycleFrames to
 * powers of 2 means a "C" note in the pattern always plays as some C —
 * never a detuned C-ish — regardless of which slider value the user picks.
 */
export const MUSICAL_CYCLE_FRAMES: readonly number[] = (() => {
  const out: number[] = [];
  for (let n = CYCLE_FRAMES_MIN; n <= CYCLE_FRAMES_MAX; n *= 2) out.push(n);
  return out;
})();

/**
 * Snap to the nearest octave-aligned cycle length. The slider lets the
 * user drag through the [MIN, MAX] range continuously; this collapses
 * each input to the closest musically-clean value so PT note triggers
 * stay in tune across slider edits.
 */
export function snapCycleFramesToMusical(v: number): number {
  if (!Number.isFinite(v)) return CYCLE_FRAMES_MIN;
  const list = MUSICAL_CYCLE_FRAMES;
  const clamped = Math.max(list[0]!, Math.min(list[list.length - 1]!, v));
  let best = list[0]!;
  let bestDist = Math.abs(clamped - best);
  for (let i = 1; i < list.length; i++) {
    const d = Math.abs(clamped - list[i]!);
    if (d < bestDist) { best = list[i]!; bestDist = d; }
  }
  return best;
}

// ─── Defaults ────────────────────────────────────────────────────────────

export function defaultOscillator(): Oscillator {
  return { shapeIndex: 0, phaseSplit: 0.5 };
}

export function defaultChiptuneParams(): ChiptuneParams {
  return {
    cycleFrames: 64, // a power-of-2, so musical from the start
    amplitude: 1,
    osc1: { shapeIndex: 2, phaseSplit: 0.5 }, // square — distinctly chip-y
    osc2: { shapeIndex: 0, phaseSplit: 0.5 }, // sine
    combineMode: 'morph',
    combineAmount: 0,                          // default to "osc1 only"
  };
}

// ─── Pure shape functions ────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

function sine(p: number): number {
  return Math.sin(TWO_PI * p);
}
function triangle(p: number): number {
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}
function square(p: number): number {
  return p < 0.5 ? 1 : -1;
}
function saw(p: number): number {
  return 2 * p - 1;
}

const SHAPES = [sine, triangle, square, saw] as const;

// ─── Building blocks ─────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Linear blend between adjacent shapes for fractional shape indices.
 * idx is clamped to [0, 3]; idx=3 returns pure saw.
 */
export function morphShape(phase: number, idx: number): number {
  const i = clamp(idx, SHAPE_INDEX_MIN, SHAPE_INDEX_MAX);
  const k = Math.floor(i);
  const f = i - k;
  if (f === 0 || k === SHAPE_INDEX_MAX) return SHAPES[k]!(phase);
  return (1 - f) * SHAPES[k]!(phase) + f * SHAPES[k + 1]!(phase);
}

/**
 * Warp t∈[0,1) so phase 0.5 lands at fraction `split` of the cycle. With
 * split=0.5 this is the identity. With split<0.5 the first half of the
 * underlying shape is compressed (e.g. square becomes a narrow pulse).
 */
export function splitPhase(t: number, split: number): number {
  const s = clamp(split, PHASE_SPLIT_MIN, PHASE_SPLIT_MAX);
  if (t < s) return (t * 0.5) / s;
  return 0.5 + ((t - s) * 0.5) / (1 - s);
}

function oscSample(t: number, osc: Oscillator): number {
  return morphShape(splitPhase(t, osc.phaseSplit), osc.shapeIndex);
}

/**
 * 8-bit signed XOR of two normalised samples. Quantises both to int8, XORs
 * the byte, sign-extends back, returns float in [-1, 1]. Gives the crunchy
 * digital character that's hard to get from continuous-domain ops.
 */
function xorInt8(a: number, b: number): number {
  const ia = Math.round(clamp(a, -1, 1) * 127) & 0xff;
  const ib = Math.round(clamp(b, -1, 1) * 127) & 0xff;
  // Sign-extend the XOR'd byte (shift up to bit 31, arithmetic-shift back).
  const x = ((ia ^ ib) << 24) >> 24;
  return x / 127;
}

// ─── Render ──────────────────────────────────────────────────────────────

/**
 * Generate one cycle of the synth as Float32 mono. Sample rate is set to
 * the rate Paula reads at C-2 (PAL) just so the WavData is well-formed —
 * pitch in PT comes from the period applied to the cycle length, not from
 * the sample rate, so this number is informational.
 */
export function generateChiptuneCycle(p: ChiptuneParams): WavData {
  const N = Math.max(2, Math.floor(p.cycleFrames));
  const out = new Float32Array(N);
  const amp = clamp(p.amplitude, 0, 1);
  const amount = p.combineAmount;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const o2 = oscSample(t, p.osc2);
    let s: number;
    switch (p.combineMode) {
      case 'sum': {
        const o1 = oscSample(t, p.osc1);
        s = o1 + amount * o2;
        break;
      }
      case 'morph': {
        const o1 = oscSample(t, p.osc1);
        s = (1 - amount) * o1 + amount * o2;
        break;
      }
      case 'ring': {
        const o1 = oscSample(t, p.osc1);
        s = (1 - amount) * o1 + amount * (o1 * o2);
        break;
      }
      case 'am': {
        const o1 = oscSample(t, p.osc1);
        s = o1 * (1 + amount * o2);
        break;
      }
      case 'fm': {
        // Modulate osc1's time by osc2's instantaneous output. Wrap into
        // [0,1) so the warp / shape-morph stages see a normal phase.
        const modT = ((t + amount * o2) % 1 + 1) % 1;
        s = oscSample(modT, p.osc1);
        break;
      }
      case 'min': {
        const o1 = oscSample(t, p.osc1);
        s = (1 - amount) * o1 + amount * Math.min(o1, o2);
        break;
      }
      case 'max': {
        const o1 = oscSample(t, p.osc1);
        s = (1 - amount) * o1 + amount * Math.max(o1, o2);
        break;
      }
      case 'xor': {
        const o1 = oscSample(t, p.osc1);
        s = (1 - amount) * o1 + amount * xorInt8(o1, o2);
        break;
      }
    }
    out[i] = s * amp;
  }
  return {
    sampleRate: rateForC2(),
    channels: [out],
  };
}

function rateForC2(): number {
  const period = PERIOD_TABLE[0]?.[12] ?? 428;
  return (PAULA_CLOCK_PAL / 2) / period;
}

// ─── Serialisation ───────────────────────────────────────────────────────

/**
 * Round-trip-friendly JSON shape for `.retro` persistence. Returns null on
 * any structural mismatch — consumers fall back to defaults.
 */
export function chiptuneFromJson(v: unknown): ChiptuneParams | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const osc = (k: string): Oscillator | null => {
    const o = x[k];
    if (!o || typeof o !== 'object') return null;
    const oo = o as Record<string, unknown>;
    if (typeof oo['shapeIndex'] !== 'number' || typeof oo['phaseSplit'] !== 'number') return null;
    return {
      shapeIndex: clamp(oo['shapeIndex'], SHAPE_INDEX_MIN, SHAPE_INDEX_MAX),
      phaseSplit: clamp(oo['phaseSplit'], PHASE_SPLIT_MIN, PHASE_SPLIT_MAX),
    };
  };
  const o1 = osc('osc1');
  const o2 = osc('osc2');
  if (!o1 || !o2) return null;
  if (typeof x['cycleFrames'] !== 'number') return null;
  if (typeof x['amplitude'] !== 'number') return null;
  if (typeof x['combineAmount'] !== 'number') return null;
  if (typeof x['combineMode'] !== 'string'
    || !(COMBINE_MODES as readonly string[]).includes(x['combineMode'])) return null;
  // Snap cycleFrames to the nearest musical (octave-aligned) value so a
  // saved-then-loaded `.retro` always restores to an in-tune cycle length,
  // even if the underlying snap rule changed between versions.
  return {
    cycleFrames: snapCycleFramesToMusical(x['cycleFrames']),
    amplitude: clamp(x['amplitude'], 0, 1),
    osc1: o1,
    osc2: o2,
    combineMode: x['combineMode'] as CombineMode,
    combineAmount: x['combineAmount'],
  };
}
