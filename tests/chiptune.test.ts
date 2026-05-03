import { describe, expect, it } from 'vitest';
import {
  morphShape, splitPhase,
  generateChiptuneCycle, defaultChiptuneParams, chiptuneFromJson,
  type ChiptuneParams,
} from '../src/core/audio/chiptune';

function withDefaults(patch: Partial<ChiptuneParams>): ChiptuneParams {
  return { ...defaultChiptuneParams(), ...patch };
}

describe('morphShape', () => {
  it('returns a pure shape at integer indices', () => {
    // sine(0) = 0, sine(0.25) = 1
    expect(morphShape(0, 0)).toBeCloseTo(0, 6);
    expect(morphShape(0.25, 0)).toBeCloseTo(1, 6);
    // triangle(0) = -1, triangle(0.25) = 0, triangle(0.5) = 1
    expect(morphShape(0, 1)).toBeCloseTo(-1, 6);
    expect(morphShape(0.25, 1)).toBeCloseTo(0, 6);
    expect(morphShape(0.5, 1)).toBeCloseTo(1, 6);
    // square: +1 below 0.5, -1 above
    expect(morphShape(0.25, 2)).toBe(1);
    expect(morphShape(0.75, 2)).toBe(-1);
    // saw: linear from -1 to ~+1
    expect(morphShape(0, 3)).toBe(-1);
    expect(morphShape(0.5, 3)).toBe(0);
  });

  it('linearly blends between adjacent shapes for fractional indices', () => {
    // At idx=0.5 we expect 50% sine + 50% triangle.
    const p = 0.25;
    const sine = Math.sin(Math.PI * 2 * p);   // 1
    const tri  = 4 * p - 1;                   // 0
    expect(morphShape(p, 0.5)).toBeCloseTo(0.5 * sine + 0.5 * tri, 6);
  });

  it('clamps to the saw at index 3+', () => {
    expect(morphShape(0.5, 3)).toBe(0);
    expect(morphShape(0.5, 5)).toBe(0); // clamped to 3
  });
});

describe('splitPhase', () => {
  it('is the identity at split=0.5', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(splitPhase(t, 0.5)).toBeCloseTo(t, 9);
    }
  });

  it('at split=0.25, the cycle midpoint (phase=0.5) lands at t=0.25', () => {
    expect(splitPhase(0.25, 0.25)).toBeCloseTo(0.5, 9);
    // First quarter compressed: t=0 → phase=0, t=0.125 → phase=0.25
    expect(splitPhase(0, 0.25)).toBeCloseTo(0, 9);
    expect(splitPhase(0.125, 0.25)).toBeCloseTo(0.25, 9);
    // Last 75% stretched: t=0.625 → phase=0.75
    expect(splitPhase(0.625, 0.25)).toBeCloseTo(0.75, 9);
  });

  it('clamps split into the safe range', () => {
    // split=0 would divide by zero; effective lower bound is 0.05.
    expect(Number.isFinite(splitPhase(0.5, 0))).toBe(true);
    expect(Number.isFinite(splitPhase(0.5, 1))).toBe(true);
  });
});

describe('generateChiptuneCycle — basic shapes', () => {
  it('produces a clean square at osc1=square, amount=0', () => {
    const p = withDefaults({
      cycleFrames: 8,
      amplitude: 1,
      osc1: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 },
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
      combineMode: 'morph',
      combineAmount: 0,
    });
    const w = generateChiptuneCycle(p);
    const ch = Array.from(w.channels[0]!);
    // First half +1, second half -1.
    expect(ch.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(4)).toEqual([-1, -1, -1, -1]);
  });

  it('honours cycleFrames length', () => {
    const w = generateChiptuneCycle(withDefaults({ cycleFrames: 32 }));
    expect(w.channels[0]!.length).toBe(32);
  });

  it('amplitude scales the output uniformly', () => {
    const full = generateChiptuneCycle(withDefaults({
      cycleFrames: 8,
      amplitude: 1,
      osc1: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 },
      combineAmount: 0,
    }));
    const half = generateChiptuneCycle(withDefaults({
      cycleFrames: 8,
      amplitude: 0.5,
      osc1: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 },
      combineAmount: 0,
    }));
    for (let i = 0; i < 8; i++) {
      expect(half.channels[0]![i]!).toBeCloseTo(0.5 * full.channels[0]![i]!, 9);
    }
  });
});

describe('generateChiptuneCycle — combine modes', () => {
  const baseOscs = {
    osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },  // sine
    osc2: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 },  // square
  };

  it('sum at amount=0 ≡ osc1 only', () => {
    const a = generateChiptuneCycle(withDefaults({
      cycleFrames: 16, amplitude: 1, ...baseOscs,
      combineMode: 'morph', combineAmount: 0,
    }));
    const b = generateChiptuneCycle(withDefaults({
      cycleFrames: 16, amplitude: 1, ...baseOscs,
      combineMode: 'sum', combineAmount: 0,
    }));
    for (let i = 0; i < 16; i++) {
      expect(b.channels[0]![i]!).toBeCloseTo(a.channels[0]![i]!, 9);
    }
  });

  it('morph at amount=0.5 ≡ average of osc1 and osc2', () => {
    const w = generateChiptuneCycle(withDefaults({
      cycleFrames: 16, amplitude: 1, ...baseOscs,
      combineMode: 'morph', combineAmount: 0.5,
    }));
    for (let i = 0; i < 16; i++) {
      const t = i / 16;
      const o1 = Math.sin(Math.PI * 2 * t);
      const o2 = t < 0.5 ? 1 : -1;
      expect(w.channels[0]![i]!).toBeCloseTo(0.5 * o1 + 0.5 * o2, 6);
    }
  });

  it('fm at amount=0 ≡ osc1', () => {
    const ref = generateChiptuneCycle(withDefaults({
      cycleFrames: 16, ...baseOscs, combineMode: 'morph', combineAmount: 0,
    }));
    const fm = generateChiptuneCycle(withDefaults({
      cycleFrames: 16, ...baseOscs, combineMode: 'fm', combineAmount: 0,
    }));
    for (let i = 0; i < 16; i++) {
      expect(fm.channels[0]![i]!).toBeCloseTo(ref.channels[0]![i]!, 9);
    }
  });

  it('ring at amount=1 with osc1=ones and osc2=square gives ±osc2', () => {
    // Triangle at phase 0.25 = 0; pick osc1 = saw at phase 0.5 (=0)? Use a
    // simpler harness: osc1 = sine at phase 0.25 = 1.0, then ring with
    // osc2 = ±1 square equals ±1. We sample at one frame to verify the
    // multiplicative shape.
    const w = generateChiptuneCycle(withDefaults({
      cycleFrames: 4, amplitude: 1,
      osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine: 0,1,0,-1
      osc2: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 }, // square: 1,1,-1,-1
      combineMode: 'ring', combineAmount: 1,
    }));
    // at amount=1 → (1-1)·o1 + 1·(o1·o2) = o1·o2
    // i=0: 0 · 1 = 0; i=1: 1 · 1 = 1; i=2: 0 · -1 = 0; i=3: -1 · -1 = 1
    const expected = [0, 1, 0, 1];
    Array.from(w.channels[0]!).forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i]!, 6);
    });
  });

  it('xor at amount=1 produces 8-bit XOR of osc1 and osc2', () => {
    // osc1 = +1 (saw at end of cycle is just under +1 due to 2t-1; at i=0 of
    // the cycle saw=-1). Use two squares — at amount=1 the formula is
    // xor8(o1, o2).  square=1 → byte 127, square=-1 → byte 0x81 (-127). XOR
    // of 127 and 127 is 0; XOR of 127 and 0x81 is 0xFE → -2 → -2/127.
    const w = generateChiptuneCycle(withDefaults({
      cycleFrames: 8, amplitude: 1,
      osc1: { shapeIndex: 2, phaseSplit: 0.5, ratio: 1 }, // 1,1,1,1,-1,-1,-1,-1
      osc2: { shapeIndex: 2, phaseSplit: 0.25, ratio: 1 }, // -1 except for first 25%
      combineMode: 'xor', combineAmount: 1,
    }));
    // At i=0, phaseSplit 0.25 puts the +1 region in [0, 0.25) → t=0 ∈ +1.
    // o1=+1 (byte 127), o2=+1 (byte 127), 127 XOR 127 = 0 → 0/127 = 0.
    expect(w.channels[0]![0]!).toBeCloseTo(0, 6);
    // At i=4, t=0.5 → o1=-1, o2=-1, byte 0x81 XOR 0x81 = 0 → 0
    expect(w.channels[0]![4]!).toBeCloseTo(0, 6);
  });

  it('is deterministic for identical params', () => {
    const p = defaultChiptuneParams();
    const a = generateChiptuneCycle(p);
    const b = generateChiptuneCycle(p);
    expect(Array.from(a.channels[0]!)).toEqual(Array.from(b.channels[0]!));
  });
});

describe('chiptuneFromJson', () => {
  it('round-trips a default params object', () => {
    const orig = defaultChiptuneParams();
    const restored = chiptuneFromJson(JSON.parse(JSON.stringify(orig)));
    expect(restored).toEqual(orig);
  });

  it('rejects non-objects and missing fields', () => {
    expect(chiptuneFromJson(null)).toBeNull();
    expect(chiptuneFromJson({})).toBeNull();
    expect(chiptuneFromJson({ ...defaultChiptuneParams(), combineMode: 'bogus' }))
      .toBeNull();
  });

  it('snaps cycleFrames to the nearest octave-aligned (musical) value', () => {
    // 99 lies between 64 and 128; closer to 128.
    const p = chiptuneFromJson({ ...defaultChiptuneParams(), cycleFrames: 99 });
    expect(p?.cycleFrames).toBe(128);
    // Out-of-range values clamp into the [MIN, MAX] band first, then snap.
    const big = chiptuneFromJson({ ...defaultChiptuneParams(), cycleFrames: 99999 });
    expect(big?.cycleFrames).toBe(256);
    // Already-musical values pass through unchanged.
    const exact = chiptuneFromJson({ ...defaultChiptuneParams(), cycleFrames: 64 });
    expect(exact?.cycleFrames).toBe(64);
  });

  it('clamps oscillator params to safe ranges', () => {
    const p = chiptuneFromJson({
      ...defaultChiptuneParams(),
      osc1: { shapeIndex: 99, phaseSplit: -1, ratio: 1 },
      osc2: { shapeIndex: -1, phaseSplit: 99, ratio: 1 },
    });
    expect(p?.osc1.shapeIndex).toBe(3);
    expect(p?.osc1.phaseSplit).toBeCloseTo(0.05, 6);
    expect(p?.osc2.shapeIndex).toBe(0);
    expect(p?.osc2.phaseSplit).toBeCloseTo(0.95, 6);
  });

  it('snaps ratio to the nearest power-of-two and back-fills missing ratio with 1', () => {
    const snapped = chiptuneFromJson({
      ...defaultChiptuneParams(),
      osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 3 },
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 99 },
    });
    expect(snapped?.osc1.ratio).toBe(2);
    expect(snapped?.osc2.ratio).toBe(8);

    // Older v=2 payloads have no `ratio` field — load at the fundamental.
    const v2 = chiptuneFromJson({
      ...defaultChiptuneParams(),
      osc1: { shapeIndex: 0, phaseSplit: 0.5 },
      osc2: { shapeIndex: 0, phaseSplit: 0.5 },
    });
    expect(v2?.osc1.ratio).toBe(1);
    expect(v2?.osc2.ratio).toBe(1);
  });
});

describe('generateChiptuneCycle — multi-cycle ratios', () => {
  it('output length collapses to N / min(ratio): both ratios = 2 → length = N/2', () => {
    const w = generateChiptuneCycle(withDefaults({
      cycleFrames: 64,
      osc1: { shapeIndex: 2, phaseSplit: 0.5, ratio: 2 },
      osc2: { shapeIndex: 2, phaseSplit: 0.5, ratio: 2 },
      combineMode: 'morph', combineAmount: 0,
    }));
    expect(w.channels[0]!.length).toBe(32);
  });

  it('higher-ratio osc wraps inside the longer cycle', () => {
    // osc1 (carrier) at ratio 1: one cycle in N=16 samples.
    // osc2 (modulator) at ratio 2: two cycles in the same span. Sum mode
    // makes the wrapping observable on its own. With osc1 silent (sine at
    // phase 0 = 0) we can isolate osc2's contribution.
    const w = generateChiptuneCycle(withDefaults({
      cycleFrames: 16,
      amplitude: 1,
      osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine
      osc2: { shapeIndex: 2, phaseSplit: 0.5, ratio: 2 }, // square @ 2x
      combineMode: 'morph', combineAmount: 1, // pure osc2
    }));
    const ch = Array.from(w.channels[0]!);
    expect(ch.length).toBe(16);
    // Square at ratio 2 across 16 samples wraps every 8 samples → high for
    // first 4, low for next 4, repeated.
    expect(ch.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(4, 8)).toEqual([-1, -1, -1, -1]);
    expect(ch.slice(8, 12)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(12, 16)).toEqual([-1, -1, -1, -1]);
  });

  it('ratio 1 + ratio 1 matches single-cycle behaviour', () => {
    // Sanity-check that the new code path is byte-equivalent to the old
    // single-cycle render when both ratios are at the fundamental.
    const single = generateChiptuneCycle(defaultChiptuneParams());
    const explicit = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      osc1: { ...defaultChiptuneParams().osc1, ratio: 1 },
      osc2: { ...defaultChiptuneParams().osc2, ratio: 1 },
    });
    expect(Array.from(single.channels[0]!)).toEqual(Array.from(explicit.channels[0]!));
  });
});
