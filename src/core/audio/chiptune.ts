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
 * AM / FM / min / max / xor (8-bit signed). After the combine stage a
 * single-param shaper (hard/soft clip, wavefold, Chebyshev, bitcrush)
 * adds extra harmonic content before the final amp scaling.
 */
import type { WavData } from "./wav";
import { PAULA_CLOCK_PAL, PERIOD_TABLE } from "../mod/format";
import {
  applyShaper,
  SHAPER_MODES,
  type ShaperMode,
} from "./shapers";

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
  /**
   * Cycles per base-cycle: how many full revolutions of THIS oscillator fit
   * into the workbench's `cycleFrames`. Each doubling moves the osc one
   * octave up (1=fundamental, 2=+1 oct, 4=+2 oct, 8=+3 oct). Restricted to
   * powers of two so the shorter-cycle osc wraps cleanly inside the longer
   * one and the final sample length stays octave-aligned.
   */
  ratio: number;
}

export type CombineMode =
  | "sum" // o1 + amount · o2  (additive, can clip)
  | "morph" // (1-amount)·o1 + amount·o2  (level-preserving crossfade)
  | "ring" // (1-amount)·o1 + amount·(o1·o2)  (ring modulation)
  | "am" // o1 · (1 + amount · o2)  (amplitude modulation)
  | "fm" // o1 with phase modulated by amount · o2
  | "min" // (1-amount)·o1 + amount·min(o1,o2)
  | "max" // (1-amount)·o1 + amount·max(o1,o2)
  | "xor"; // 8-bit signed XOR, blended with o1 by amount

export const COMBINE_MODES: readonly CombineMode[] = [
  "sum",
  "morph",
  "ring",
  "am",
  "fm",
  "min",
  "max",
  "xor",
] as const;

export const COMBINE_LABELS: Readonly<Record<CombineMode, string>> = {
  sum: "Sum",
  morph: "Morph",
  ring: "Ring",
  am: "AM",
  fm: "FM",
  min: "Min",
  max: "Max",
  xor: "XOR",
};

/** What a single chiptune-LFO modulates. Targets are chosen one at a time. */
export type LfoTarget =
  | "osc1Shape"
  | "osc1PhaseSplit"
  | "osc2Shape"
  | "osc2PhaseSplit"
  | "combineAmount"
  | "shaperAmount"
  | "amplitude";

export const LFO_TARGETS: readonly LfoTarget[] = [
  "osc1Shape",
  "osc1PhaseSplit",
  "osc2Shape",
  "osc2PhaseSplit",
  "combineAmount",
  "shaperAmount",
  "amplitude",
] as const;

export const LFO_TARGET_LABELS: Readonly<Record<LfoTarget, string>> = {
  osc1Shape: "Osc 1 Shape",
  osc1PhaseSplit: "Osc 1 Phase split",
  osc2Shape: "Osc 2 Shape",
  osc2PhaseSplit: "Osc 2 Phase split",
  combineAmount: "Combine amount",
  shaperAmount: "Shaper drive",
  amplitude: "Amplitude",
};

export interface Lfo {
  /**
   * How many "base cycles" the LFO covers in a single LFO cycle. The
   * rendered sample length is `baseCycle × cycleMultiplier`, so the LFO
   * completes one triangle pass over the whole rendered output. Restricted
   * to powers of two so the longer rendered sample stays octave-aligned.
   */
  cycleMultiplier: number;
  /**
   * Modulation depth, 0..1. Scaled by the target's natural range so 1.0
   * sweeps the full range regardless of which target is picked (e.g. for
   * shape, 0..3; for phase split, 0.05..0.95).
   */
  amplitude: number;
  /** Which chiptune param the LFO drives. */
  target: LfoTarget;
}

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
  /** End-of-pipeline shaper mode (between combine and final amp). */
  shaperMode: ShaperMode;
  /** 0..1. 0 = bypass, 1 = full effect, regardless of which mode is picked. */
  shaperAmount: number;
  /**
   * Slow modulator. Generates a unipolar triangle (0 → 1 → 0) over the
   * rendered output and adds it (scaled by amplitude × target range) to
   * the chosen target on a per-sample basis. Set `amplitude: 0` to
   * effectively disable the LFO without removing the section.
   * LFO 1's `cycleMultiplier` defines the rendered output length.
   */
  lfo: Lfo;
  /**
   * Faster sub-modulator that runs alongside LFO 1. Its
   * `cycleMultiplier` is snapped to a divisor of LFO 1's so the loop
   * point stays clean — LFO 2 completes `m1/m2` integer triangles
   * inside the rendered output. Set `amplitude: 0` to disable.
   */
  lfo2: Lfo;
}

export const CYCLE_FRAMES_MIN = 8;
export const CYCLE_FRAMES_MAX = 256;
export const SHAPE_INDEX_MIN = 0;
export const SHAPE_INDEX_MAX = 5;
export const PHASE_SPLIT_MIN = 0.05;
export const PHASE_SPLIT_MAX = 0.95;
export const RATIO_MIN = 1;
export const RATIO_MAX = 8;

/** Power-of-two ratios — each step is an octave up from the fundamental. */
export const MUSICAL_RATIOS: readonly number[] = [1, 2, 4, 8];

/**
 * LFO multiplier range. Any integer ≥ 1 keeps the rendered output an
 * integer multiple of the base cycle, so each oscillator lands back at
 * phase 0 at the end of the sample (seamless loop). No power-of-two
 * constraint here — the multiplier doesn't affect pitch the way
 * `cycleFrames` does, it just spreads the LFO across a longer rendered
 * span. 256 keeps the int8 output safely under PT's 131 070-byte
 * sample ceiling (256 × 256 = 65 536 bytes worst-case — half of max).
 */
export const LFO_MULT_MIN = 1;
export const LFO_MULT_MAX = 256;

/** Round to the nearest integer in `[LFO_MULT_MIN, LFO_MULT_MAX]`. */
export function snapLfoMultiplier(v: number): number {
  if (!Number.isFinite(v)) return LFO_MULT_MIN;
  return Math.max(LFO_MULT_MIN, Math.min(LFO_MULT_MAX, Math.round(v)));
}

/**
 * Snap `value` to the nearest divisor of `total` in [1, total]. Used by
 * LFO 2 to keep its cycle length a clean fraction of the rendered
 * output (which is `baseLen × LFO 1's cycleMultiplier`). With m2
 * dividing m1, the second LFO completes `m1/m2` integer triangles
 * across the output, so it lands at phase 0 at every loop point.
 */
export function snapLfoMultiplierToDivisor(
  value: number,
  total: number,
): number {
  const t = Math.max(1, Math.floor(total));
  if (!Number.isFinite(value) || t === 1) return 1;
  let best = 1;
  let bestDist = Math.abs(value - 1);
  for (let d = 2; d <= t; d++) {
    if (t % d !== 0) continue;
    const dist = Math.abs(value - d);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** Snap an arbitrary slider value to the nearest power-of-two ratio. */
export function snapRatioToMusical(v: number): number {
  if (!Number.isFinite(v)) return RATIO_MIN;
  const list = MUSICAL_RATIOS;
  const clamped = Math.max(list[0]!, Math.min(list[list.length - 1]!, v));
  let best = list[0]!;
  let bestDist = Math.abs(clamped - best);
  for (let i = 1; i < list.length; i++) {
    const d = Math.abs(clamped - list[i]!);
    if (d < bestDist) {
      best = list[i]!;
      bestDist = d;
    }
  }
  return best;
}

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
    if (d < bestDist) {
      best = list[i]!;
      bestDist = d;
    }
  }
  return best;
}

// ─── Defaults ────────────────────────────────────────────────────────────

export function defaultOscillator(): Oscillator {
  return { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 };
}

export function defaultLfo(): Lfo {
  // Off by default (amplitude=0). Multiplier=1 keeps the rendered output
  // at its natural cycle length, so toggling amplitude up later doesn't
  // suddenly resize the sample.
  return { cycleMultiplier: 1, amplitude: 0, target: "osc1Shape" };
}

export function defaultChiptuneParams(): ChiptuneParams {
  return {
    cycleFrames: 64, // a power-of-2, so musical from the start
    amplitude: 1,
    osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // square — distinctly chip-y
    osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine
    combineMode: "morph",
    combineAmount: 0, // default to "osc1 only"
    shaperMode: "none", // off by default — user opts in
    shaperAmount: 0,
    lfo: defaultLfo(),
    lfo2: defaultLfo(),
  };
}

// ─── Pure shape functions ────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

function sine(p: number): number {
  return Math.sin(TWO_PI * p);
}
// Triangle and saw are zero at the cycle seam (p=0 and p=1) so a looping
// sample doesn't introduce a DC step at the loop point — that step is
// what produces audible clicks on bass tones at long cycle lengths.
// Triangle: 0 → +1 (p=0.25) → 0 (p=0.5) → −1 (p=0.75) → 0.
function triangle(p: number): number {
  if (p < 0.25) return 4 * p;
  if (p < 0.75) return 2 - 4 * p;
  return 4 * p - 4;
}
// 15-level quantised triangle — NES-bass-channel grit. Odd level count
// means 0 is one of the steps, so the wave still passes through 0 at
// the cycle seam (no attack click). Sits between triangle and trapezoid
// in the morph chain; sounds like a digital triangle / stepped saw.
const STAIR_LEVELS = 15;
const STAIR_STEP = 2 / (STAIR_LEVELS - 1);
function stairTriangle(p: number): number {
  const t = triangle(p);
  return Math.round((t + 1) / STAIR_STEP) * STAIR_STEP - 1;
}
// Trapezoid — fast ramps separated by long flats. 1/8 cycle ramp up to
// +1, 2/8 flat, 2/8 ramp down through 0, 2/8 flat at -1, 1/8 ramp back
// to 0. Reads as a "fat" square: most of the punch of square but
// smoother corners and softer attack. Loop-clean (starts and ends at 0).
function trapezoid(p: number): number {
  if (p < 1 / 8) return 8 * p;
  if (p < 3 / 8) return 1;
  if (p < 5 / 8) return 1 - 8 * (p - 3 / 8);
  if (p < 7 / 8) return -1;
  return -1 + 8 * (p - 7 / 8);
}
function square(p: number): number {
  return p < 0.5 ? 1 : -1;
}
// Saw: ramps 0 → +1 (just before p=0.5), drops to −1 at p=0.5, ramps
// back to 0 at p=1. The hard step now sits in the middle of the cycle
// instead of at the seam, where it would alias with the loop point.
function saw(p: number): number {
  return p < 0.5 ? 2 * p : 2 * p - 2;
}

// Order matters — the morph chain blends adjacent entries linearly, so
// neighbours should sound related. Reads as a smoothness/grit axis:
// pure sine → soft triangle → digital stair → fat trapezoid → harsh
// square → all-harmonic saw.
const SHAPES = [
  sine,
  triangle,
  stairTriangle,
  trapezoid,
  square,
  saw,
] as const;

// ─── Building blocks ─────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Linear blend between adjacent shapes for fractional shape indices.
 * idx is clamped to [SHAPE_INDEX_MIN, SHAPE_INDEX_MAX]; the maximum
 * returns the last shape in the morph chain (saw).
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
 *
 * Multi-cycle behaviour: each oscillator's `ratio` decides how many of its
 * cycles fit into the workbench's `cycleFrames`. The final sample length
 * is the LONGEST individual cycle (cycleFrames / min(r1, r2)) — i.e. the
 * lowest-pitch oscillator's period — and the higher-pitch (shorter-cycle)
 * oscillator wraps inside that span. With both ratios at 1 the output is
 * identical to the single-cycle path.
 */
export function generateChiptuneCycle(p: ChiptuneParams): WavData {
  const N = Math.max(2, Math.floor(p.cycleFrames));
  const r1 = Math.max(RATIO_MIN, Math.floor(p.osc1.ratio));
  const r2 = Math.max(RATIO_MIN, Math.floor(p.osc2.ratio));
  const minR = Math.min(r1, r2);
  const baseLen = Math.max(2, Math.floor(N / minR));
  // LFO 1 extends the output to `baseLen × m1` so one LFO 1 triangle
  // covers the entire rendered sample. Oscillator phase formulas
  // (`(i·R) / N % 1`) wrap correctly inside the longer span. LFO 2's
  // multiplier is snapped to a divisor of m1, so its period
  // (`baseLen × m2`) divides L exactly — LFO 2 completes m1/m2
  // integer triangles inside the output, landing on phase 0 at the
  // loop point alongside LFO 1.
  const m1 = Math.max(LFO_MULT_MIN, Math.floor(p.lfo.cycleMultiplier));
  const m2 = snapLfoMultiplierToDivisor(p.lfo2.cycleMultiplier, m1);
  const L = Math.max(2, baseLen * m1);
  const period2 = Math.max(2, baseLen * m2);
  const out = new Float32Array(L);
  const baseAmp = clamp(p.amplitude, 0, 1);
  const baseAmount = p.combineAmount;
  const baseShaperAmount = clamp(p.shaperAmount, 0, 1);
  const lfoAmp1 = clamp(p.lfo.amplitude, 0, 1);
  const lfoAmp2 = clamp(p.lfo2.amplitude, 0, 1);

  // Per-target sweep range — `lfoAmp = 1` modulates the full natural span
  // of the chosen target so the slider feels equally effective whatever
  // the user routed it to.
  const shapeRange = SHAPE_INDEX_MAX - SHAPE_INDEX_MIN;
  const splitRange = PHASE_SPLIT_MAX - PHASE_SPLIT_MIN;

  // Pre-build mutable osc descriptors so we can patch their fields per
  // sample when an LFO targets one of them — saves allocating a new
  // object inside the hot loop.
  const osc1 = { ...p.osc1 };
  const osc2 = { ...p.osc2 };

  for (let i = 0; i < L; i++) {
    // Triangle 0 → 1 → 0 — unipolar. LFO 1 covers the whole output;
    // LFO 2 has its own (shorter) period that divides L cleanly.
    const lfoT1 = i / L;
    const lfoVal1 = (lfoT1 < 0.5 ? 2 * lfoT1 : 2 * (1 - lfoT1)) * lfoAmp1;
    const lfoT2 = (i % period2) / period2;
    const lfoVal2 = (lfoT2 < 0.5 ? 2 * lfoT2 : 2 * (1 - lfoT2)) * lfoAmp2;

    // Reset osc descriptors and combine/amplitude for this sample, then
    // sum each LFO's modulation into its target. Two LFOs hitting the
    // same target add; different targets stack independently.
    osc1.shapeIndex = p.osc1.shapeIndex;
    osc1.phaseSplit = p.osc1.phaseSplit;
    osc2.shapeIndex = p.osc2.shapeIndex;
    osc2.phaseSplit = p.osc2.phaseSplit;
    let combineAmt = baseAmount;
    let shaperAmt = baseShaperAmount;
    let outAmp = baseAmp;
    const applyLfo = (target: LfoTarget, lfoVal: number) => {
      switch (target) {
        case "osc1Shape":
          osc1.shapeIndex += lfoVal * shapeRange;
          break;
        case "osc1PhaseSplit":
          osc1.phaseSplit += lfoVal * splitRange;
          break;
        case "osc2Shape":
          osc2.shapeIndex += lfoVal * shapeRange;
          break;
        case "osc2PhaseSplit":
          osc2.phaseSplit += lfoVal * splitRange;
          break;
        case "combineAmount":
          combineAmt += lfoVal;
          break;
        case "shaperAmount":
          shaperAmt = clamp(shaperAmt + lfoVal, 0, 1);
          break;
        case "amplitude":
          outAmp = clamp(outAmp + lfoVal, 0, 1);
          break;
      }
    };
    applyLfo(p.lfo.target, lfoVal1);
    applyLfo(p.lfo2.target, lfoVal2);

    // Each osc's natural phase at sample i: osc with ratio R has cycle
    // length N/R, so phase = ((i * R) % N) / N. The shorter-cycle osc
    // (higher R) wraps multiple times across the output span; with the
    // LFO multiplier in play the wrapping just continues across the
    // longer rendered sample.
    const phase1 = ((i * r1) / N) % 1;
    const phase2 = ((i * r2) / N) % 1;
    const o2 = oscSample(phase2, osc2);
    let s: number;
    switch (p.combineMode) {
      case "sum": {
        const o1 = oscSample(phase1, osc1);
        s = o1 + combineAmt * o2;
        break;
      }
      case "morph": {
        const o1 = oscSample(phase1, osc1);
        s = (1 - combineAmt) * o1 + combineAmt * o2;
        break;
      }
      case "ring": {
        const o1 = oscSample(phase1, osc1);
        s = (1 - combineAmt) * o1 + combineAmt * (o1 * o2);
        break;
      }
      case "am": {
        const o1 = oscSample(phase1, osc1);
        s = o1 * (1 + combineAmt * o2);
        break;
      }
      case "fm": {
        // Modulate osc1's phase by osc2's instantaneous output. Wrap into
        // [0,1) so the warp / shape-morph stages see a normal phase.
        const modPhase = (((phase1 + combineAmt * o2) % 1) + 1) % 1;
        s = oscSample(modPhase, osc1);
        break;
      }
      case "min": {
        const o1 = oscSample(phase1, osc1);
        s = (1 - combineAmt) * o1 + combineAmt * Math.min(o1, o2);
        break;
      }
      case "max": {
        const o1 = oscSample(phase1, osc1);
        s = (1 - combineAmt) * o1 + combineAmt * Math.max(o1, o2);
        break;
      }
      case "xor": {
        const o1 = oscSample(phase1, osc1);
        s = (1 - combineAmt) * o1 + combineAmt * xorInt8(o1, o2);
        break;
      }
    }
    s = applyShaper(s, p.shaperMode, shaperAmt);
    out[i] = s * outAmp;
  }
  return {
    sampleRate: rateForC2(),
    channels: [out],
  };
}

function rateForC2(): number {
  const period = PERIOD_TABLE[0]?.[12] ?? 428;
  return PAULA_CLOCK_PAL / 2 / period;
}

// ─── Serialisation ───────────────────────────────────────────────────────

/**
 * Round-trip-friendly JSON shape for `.retro` persistence. Returns null on
 * any structural mismatch — consumers fall back to defaults.
 */
export function chiptuneFromJson(v: unknown): ChiptuneParams | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const osc = (k: string): Oscillator | null => {
    const o = x[k];
    if (!o || typeof o !== "object") return null;
    const oo = o as Record<string, unknown>;
    if (
      typeof oo["shapeIndex"] !== "number" ||
      typeof oo["phaseSplit"] !== "number"
    )
      return null;
    // `ratio` is optional for back-compat with v=2 chiptune payloads saved
    // before the multi-cycle rewrite — those are restored at ratio=1, the
    // single-cycle behaviour they were authored against.
    const rawRatio = typeof oo["ratio"] === "number" ? oo["ratio"] : 1;
    return {
      shapeIndex: clamp(oo["shapeIndex"], SHAPE_INDEX_MIN, SHAPE_INDEX_MAX),
      phaseSplit: clamp(oo["phaseSplit"], PHASE_SPLIT_MIN, PHASE_SPLIT_MAX),
      ratio: snapRatioToMusical(rawRatio),
    };
  };
  const o1 = osc("osc1");
  const o2 = osc("osc2");
  if (!o1 || !o2) return null;
  if (typeof x["cycleFrames"] !== "number") return null;
  if (typeof x["amplitude"] !== "number") return null;
  if (typeof x["combineAmount"] !== "number") return null;
  if (
    typeof x["combineMode"] !== "string" ||
    !(COMBINE_MODES as readonly string[]).includes(x["combineMode"])
  )
    return null;
  // `lfo` is optional for back-compat with payloads saved before the
  // LFO addition — those restore with the LFO disabled (defaultLfo).
  // `lfo2` is also optional, missing in payloads predating the second
  // LFO; it restores disabled.
  const lfo = parseLfo(x["lfo"]);
  const lfo2 = parseLfo(x["lfo2"]);
  // `shaperMode` / `shaperAmount` are optional for back-compat with
  // payloads saved before the shaper addition — those restore with the
  // shaper bypassed.
  const rawShaperMode = x["shaperMode"];
  const shaperMode: ShaperMode =
    typeof rawShaperMode === "string" &&
    (SHAPER_MODES as readonly string[]).includes(rawShaperMode)
      ? (rawShaperMode as ShaperMode)
      : "none";
  const shaperAmount =
    typeof x["shaperAmount"] === "number" ? clamp(x["shaperAmount"], 0, 1) : 0;
  // Snap cycleFrames to the nearest musical (octave-aligned) value so a
  // saved-then-loaded `.retro` always restores to an in-tune cycle length,
  // even if the underlying snap rule changed between versions.
  return {
    cycleFrames: snapCycleFramesToMusical(x["cycleFrames"]),
    amplitude: clamp(x["amplitude"], 0, 1),
    osc1: o1,
    osc2: o2,
    combineMode: x["combineMode"] as CombineMode,
    combineAmount: x["combineAmount"],
    shaperMode,
    shaperAmount,
    lfo,
    lfo2,
  };
}

function parseLfo(raw: unknown): Lfo {
  if (!raw || typeof raw !== "object") return defaultLfo();
  const r = raw as Record<string, unknown>;
  const target = r["target"];
  return {
    cycleMultiplier:
      typeof r["cycleMultiplier"] === "number" ? r["cycleMultiplier"] : 1,
    amplitude:
      typeof r["amplitude"] === "number" ? clamp(r["amplitude"], 0, 1) : 0,
    target:
      typeof target === "string" &&
      (LFO_TARGETS as readonly string[]).includes(target)
        ? (target as LfoTarget)
        : "osc1Shape",
  };
}
