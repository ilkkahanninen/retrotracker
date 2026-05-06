import { describe, expect, it } from "vitest";
import {
  morphShape,
  splitPhase,
  generateChiptuneCycle,
  defaultChiptuneParams,
  chiptuneFromJson,
  snapLfoMultiplierToDivisor,
  type ChiptuneParams,
} from "../src/core/audio/chiptune";

function withDefaults(patch: Partial<ChiptuneParams>): ChiptuneParams {
  return { ...defaultChiptuneParams(), ...patch };
}

describe("morphShape", () => {
  it("returns a pure shape at integer indices", () => {
    // Chain: 0=sine 1=tri 2=stair 3=trap 4=sq 5=saw.
    // sine(0) = 0, sine(0.25) = 1
    expect(morphShape(0, 0)).toBeCloseTo(0, 6);
    expect(morphShape(0.25, 0)).toBeCloseTo(1, 6);
    // triangle starts at 0, peaks at +1 (p=0.25), back to 0 (p=0.5),
    // troughs at -1 (p=0.75) — chosen so loops don't click at the seam.
    expect(morphShape(0, 1)).toBeCloseTo(0, 6);
    expect(morphShape(0.25, 1)).toBeCloseTo(1, 6);
    expect(morphShape(0.5, 1)).toBeCloseTo(0, 6);
    expect(morphShape(0.75, 1)).toBeCloseTo(-1, 6);
    // stair-step triangle: 15 levels (step = 2/14 = 1/7). Quantises
    // through 0 and ±1 exactly; intermediate triangle values land on the
    // nearest 1/7-step.
    expect(morphShape(0, 2)).toBeCloseTo(0, 6);
    expect(morphShape(0.25, 2)).toBeCloseTo(1, 6);
    expect(morphShape(0.5, 2)).toBeCloseTo(0, 6);
    expect(morphShape(0.75, 2)).toBeCloseTo(-1, 6);
    // Triangle at p=0.1 = 0.4. Quantised to nearest 1/7 = 3/7 ≈ 0.4286.
    expect(morphShape(0.1, 2)).toBeCloseTo(3 / 7, 6);
    // trapezoid: ramp 0→+1 in [0, 1/8), flat at +1, ramp through 0,
    // flat at −1, ramp back to 0.
    expect(morphShape(0, 3)).toBe(0);
    expect(morphShape(1 / 8, 3)).toBe(1);
    expect(morphShape(0.25, 3)).toBe(1); // mid-flat-top
    expect(morphShape(0.5, 3)).toBeCloseTo(0, 6); // mid-fall
    expect(morphShape(5 / 8, 3)).toBe(-1);
    expect(morphShape(0.75, 3)).toBe(-1); // mid-flat-bottom
    // square: +1 below 0.5, -1 above
    expect(morphShape(0.25, 4)).toBe(1);
    expect(morphShape(0.75, 4)).toBe(-1);
    // saw also starts at 0; ramps 0→+1, jumps to -1 at p=0.5, ramps -1→0.
    expect(morphShape(0, 5)).toBe(0);
    expect(morphShape(0.25, 5)).toBe(0.5);
    expect(morphShape(0.5, 5)).toBe(-1);
    expect(morphShape(0.75, 5)).toBe(-0.5);
  });

  it("linearly blends between adjacent shapes for fractional indices", () => {
    // At idx=0.5 we expect 50% sine + 50% triangle. Pick p=0.125 where
    // sine and triangle differ so the blend is observable.
    const p = 0.125;
    const sine = Math.sin(Math.PI * 2 * p); // ≈ 0.7071
    const tri = 4 * p; // 0.5 (rising 0→1 region)
    expect(morphShape(p, 0.5)).toBeCloseTo(0.5 * sine + 0.5 * tri, 6);
  });

  it("clamps to the saw at the top of the chain", () => {
    // Saw at p=0.25 = 0.5 (rising region); same answer for index ≥ 5.
    expect(morphShape(0.25, 5)).toBe(0.5);
    expect(morphShape(0.25, 7)).toBe(0.5); // clamped to 5
  });
});

describe("splitPhase", () => {
  it("is the identity at split=0.5", () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(splitPhase(t, 0.5)).toBeCloseTo(t, 9);
    }
  });

  it("at split=0.25, the cycle midpoint (phase=0.5) lands at t=0.25", () => {
    expect(splitPhase(0.25, 0.25)).toBeCloseTo(0.5, 9);
    // First quarter compressed: t=0 → phase=0, t=0.125 → phase=0.25
    expect(splitPhase(0, 0.25)).toBeCloseTo(0, 9);
    expect(splitPhase(0.125, 0.25)).toBeCloseTo(0.25, 9);
    // Last 75% stretched: t=0.625 → phase=0.75
    expect(splitPhase(0.625, 0.25)).toBeCloseTo(0.75, 9);
  });

  it("clamps split into the safe range", () => {
    // split=0 would divide by zero; effective lower bound is 0.05.
    expect(Number.isFinite(splitPhase(0.5, 0))).toBe(true);
    expect(Number.isFinite(splitPhase(0.5, 1))).toBe(true);
  });
});

describe("generateChiptuneCycle — basic shapes", () => {
  it("produces a clean square at osc1=square, amount=0", () => {
    const p = withDefaults({
      cycleFrames: 8,
      amplitude: 1,
      osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
      combineMode: "morph",
      combineAmount: 0,
    });
    const w = generateChiptuneCycle(p);
    const ch = Array.from(w.channels[0]!);
    // First half +1, second half -1.
    expect(ch.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(4)).toEqual([-1, -1, -1, -1]);
  });

  it("honours cycleFrames length", () => {
    const w = generateChiptuneCycle(withDefaults({ cycleFrames: 32 }));
    expect(w.channels[0]!.length).toBe(32);
  });

  it("amplitude scales the output uniformly", () => {
    const full = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 8,
        amplitude: 1,
        osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
        combineAmount: 0,
      }),
    );
    const half = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 8,
        amplitude: 0.5,
        osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
        combineAmount: 0,
      }),
    );
    for (let i = 0; i < 8; i++) {
      expect(half.channels[0]![i]!).toBeCloseTo(0.5 * full.channels[0]![i]!, 9);
    }
  });
});

describe("generateChiptuneCycle — combine modes", () => {
  const baseOscs = {
    osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine
    osc2: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // square
  };

  it("morph at amount=0.5 ≡ average of osc1 and osc2", () => {
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 16,
        amplitude: 1,
        ...baseOscs,
        combineMode: "morph",
        combineAmount: 0.5,
      }),
    );
    for (let i = 0; i < 16; i++) {
      const t = i / 16;
      const o1 = Math.sin(Math.PI * 2 * t);
      const o2 = t < 0.5 ? 1 : -1;
      expect(w.channels[0]![i]!).toBeCloseTo(0.5 * o1 + 0.5 * o2, 6);
    }
  });

  it("fm at amount=0 ≡ osc1", () => {
    const ref = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 16,
        ...baseOscs,
        combineMode: "morph",
        combineAmount: 0,
      }),
    );
    const fm = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 16,
        ...baseOscs,
        combineMode: "fm",
        combineAmount: 0,
      }),
    );
    for (let i = 0; i < 16; i++) {
      expect(fm.channels[0]![i]!).toBeCloseTo(ref.channels[0]![i]!, 9);
    }
  });

  it("ring at amount=1 with osc1=ones and osc2=square gives ±osc2", () => {
    // Triangle at phase 0.25 = 0; pick osc1 = saw at phase 0.5 (=0)? Use a
    // simpler harness: osc1 = sine at phase 0.25 = 1.0, then ring with
    // osc2 = ±1 square equals ±1. We sample at one frame to verify the
    // multiplicative shape.
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 4,
        amplitude: 1,
        osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine: 0,1,0,-1
        osc2: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // square: 1,1,-1,-1
        combineMode: "ring",
        combineAmount: 1,
      }),
    );
    // at amount=1 → (1-1)·o1 + 1·(o1·o2) = o1·o2
    // i=0: 0 · 1 = 0; i=1: 1 · 1 = 1; i=2: 0 · -1 = 0; i=3: -1 · -1 = 1
    const expected = [0, 1, 0, 1];
    Array.from(w.channels[0]!).forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i]!, 6);
    });
  });

  it("xor at amount=1 produces 8-bit XOR of osc1 and osc2", () => {
    // osc1 = +1 (saw at end of cycle is just under +1 due to 2t-1; at i=0 of
    // the cycle saw=-1). Use two squares — at amount=1 the formula is
    // xor8(o1, o2).  square=1 → byte 127, square=-1 → byte 0x81 (-127). XOR
    // of 127 and 127 is 0; XOR of 127 and 0x81 is 0xFE → -2 → -2/127.
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 8,
        amplitude: 1,
        osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // 1,1,1,1,-1,-1,-1,-1
        osc2: { shapeIndex: 4, phaseSplit: 0.25, ratio: 1 }, // -1 except for first 25%
        combineMode: "xor",
        combineAmount: 1,
      }),
    );
    // At i=0, phaseSplit 0.25 puts the +1 region in [0, 0.25) → t=0 ∈ +1.
    // o1=+1 (byte 127), o2=+1 (byte 127), 127 XOR 127 = 0 → 0/127 = 0.
    expect(w.channels[0]![0]!).toBeCloseTo(0, 6);
    // At i=4, t=0.5 → o1=-1, o2=-1, byte 0x81 XOR 0x81 = 0 → 0
    expect(w.channels[0]![4]!).toBeCloseTo(0, 6);
  });

  it("is deterministic for identical params", () => {
    const p = defaultChiptuneParams();
    const a = generateChiptuneCycle(p);
    const b = generateChiptuneCycle(p);
    expect(Array.from(a.channels[0]!)).toEqual(Array.from(b.channels[0]!));
  });
});

describe("generateChiptuneCycle — offset (loop-start rotation)", () => {
  it("offset=0 leaves the output unchanged (rotation identity)", () => {
    // Square at cycleFrames=8 → first half +1, second half −1. With
    // offset=0 the historical layout is preserved bit-exact, so adding
    // the field doesn't drift the default render.
    const params = withDefaults({
      cycleFrames: 8,
      osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
      combineMode: "morph",
      combineAmount: 0,
      offset: 0,
    });
    const w = generateChiptuneCycle(params);
    expect(Array.from(w.channels[0]!)).toEqual([1, 1, 1, 1, -1, -1, -1, -1]);
  });

  it("offset=0.5 shifts the cycle so byte 0 lands at the original midpoint", () => {
    // Same square as above. offset=0.5 with L=8 → rotate by 4: byte 0 of
    // the new output = byte 4 of the original = first −1 sample.
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 8,
        osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
        osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
        combineMode: "morph",
        combineAmount: 0,
        offset: 0.5,
      }),
    );
    expect(Array.from(w.channels[0]!)).toEqual([-1, -1, -1, -1, 1, 1, 1, 1]);
  });

  it("offset=1 wraps to offset=0 (full rotation is identity)", () => {
    const make = (offset: number) =>
      generateChiptuneCycle(
        withDefaults({
          cycleFrames: 8,
          osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
          combineAmount: 0,
          offset,
        }),
      );
    expect(Array.from(make(1).channels[0]!)).toEqual(
      Array.from(make(0).channels[0]!),
    );
  });

  it("offset rotates a full LFO render — loop point stays seamless", () => {
    // With LFO 1's cycleMultiplier=2 the rendered output is 16 frames; an
    // offset of 0.5 rotates by 8 (one full base cycle). The LFO triangle
    // starts and ends at 0 in the unrotated output, so rotating moves the
    // triangle's start point but keeps the value at frame 0 == value at
    // frame L (loop seamlessness preserved).
    const params = withDefaults({
      cycleFrames: 8,
      osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 },
      combineAmount: 0,
      lfo: { cycleMultiplier: 2, amplitude: 0.5, target: "amplitude" },
      offset: 0.5,
    });
    const w = generateChiptuneCycle(params);
    expect(w.channels[0]!.length).toBe(16);
    // Seamless loop: the cycle ends at the same place it starts (within
    // the rotation's discrete-frame error). We compare the LFO-shape at
    // the loop boundary by checking that wrapping forward by L produces
    // matching values — equivalent to the loop-clean property.
    // Trivial check: the first value matches what the unrotated render
    // had at frame 8.
    const unrotated = generateChiptuneCycle({ ...params, offset: 0 });
    expect(w.channels[0]![0]).toBeCloseTo(unrotated.channels[0]![8]!, 9);
    expect(w.channels[0]![15]).toBeCloseTo(unrotated.channels[0]![7]!, 9);
  });
});

describe("chiptuneFromJson — offset back-compat", () => {
  it("falls back to offset=0 when the field is missing", () => {
    // Strip the offset field from a default-shaped JSON to simulate a
    // payload saved before the slider was added.
    const json = JSON.parse(JSON.stringify(defaultChiptuneParams())) as Record<
      string,
      unknown
    >;
    delete json["offset"];
    const restored = chiptuneFromJson(json);
    expect(restored).not.toBeNull();
    expect(restored!.offset).toBe(0);
  });

  it("clamps an out-of-range offset to [0, 1]", () => {
    const lo = chiptuneFromJson({
      ...JSON.parse(JSON.stringify(defaultChiptuneParams())),
      offset: -1,
    });
    const hi = chiptuneFromJson({
      ...JSON.parse(JSON.stringify(defaultChiptuneParams())),
      offset: 5,
    });
    expect(lo!.offset).toBe(0);
    expect(hi!.offset).toBe(1);
  });
});

describe("chiptuneFromJson", () => {
  it("round-trips a default params object", () => {
    const orig = defaultChiptuneParams();
    const restored = chiptuneFromJson(JSON.parse(JSON.stringify(orig)));
    expect(restored).toEqual(orig);
  });

  it("rejects non-objects and missing required fields", () => {
    expect(chiptuneFromJson(null)).toBeNull();
    expect(chiptuneFromJson({})).toBeNull();
  });

  it('falls back to morph for unknown / removed combineMode (e.g. legacy "sum")', () => {
    // Retired modes shouldn't drop the whole preset on load — they fall
    // back to morph so the rest of the saved chiptune still restores.
    const restored = chiptuneFromJson({
      ...defaultChiptuneParams(),
      combineMode: "sum",
    });
    expect(restored?.combineMode).toBe("morph");
    const bogus = chiptuneFromJson({
      ...defaultChiptuneParams(),
      combineMode: "totally-made-up",
    });
    expect(bogus?.combineMode).toBe("morph");
  });

  it("snaps cycleFrames to the nearest octave-aligned (musical) value", () => {
    // 99 lies between 64 and 128; closer to 128.
    const p = chiptuneFromJson({ ...defaultChiptuneParams(), cycleFrames: 99 });
    expect(p?.cycleFrames).toBe(128);
    // Out-of-range values clamp into the [MIN, MAX] band first, then snap.
    const big = chiptuneFromJson({
      ...defaultChiptuneParams(),
      cycleFrames: 99999,
    });
    expect(big?.cycleFrames).toBe(256);
    // Already-musical values pass through unchanged.
    const exact = chiptuneFromJson({
      ...defaultChiptuneParams(),
      cycleFrames: 64,
    });
    expect(exact?.cycleFrames).toBe(64);
  });

  it("clamps oscillator params to safe ranges", () => {
    const p = chiptuneFromJson({
      ...defaultChiptuneParams(),
      osc1: { shapeIndex: 99, phaseSplit: -1, ratio: 1 },
      osc2: { shapeIndex: -1, phaseSplit: 99, ratio: 1 },
    });
    expect(p?.osc1.shapeIndex).toBe(5); // clamped to SHAPE_INDEX_MAX
    expect(p?.osc1.phaseSplit).toBeCloseTo(0.05, 6);
    expect(p?.osc2.shapeIndex).toBe(0);
    expect(p?.osc2.phaseSplit).toBeCloseTo(0.95, 6);
  });

  it("snaps ratio to the nearest power-of-two and back-fills missing ratio with 1", () => {
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

describe("generateChiptuneCycle — multi-cycle ratios", () => {
  it("output length collapses to N / min(ratio): both ratios = 2 → length = N/2", () => {
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 64,
        osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 2 },
        osc2: { shapeIndex: 4, phaseSplit: 0.5, ratio: 2 },
        combineMode: "morph",
        combineAmount: 0,
      }),
    );
    expect(w.channels[0]!.length).toBe(32);
  });

  it("higher-ratio osc wraps inside the longer cycle", () => {
    // osc1 (carrier) at ratio 1: one cycle in N=16 samples.
    // osc2 (modulator) at ratio 2: two cycles in the same span. Sum mode
    // makes the wrapping observable on its own. With osc1 silent (sine at
    // phase 0 = 0) we can isolate osc2's contribution.
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 16,
        amplitude: 1,
        osc1: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 }, // sine
        osc2: { shapeIndex: 4, phaseSplit: 0.5, ratio: 2 }, // square @ 2x
        combineMode: "morph",
        combineAmount: 1, // pure osc2
      }),
    );
    const ch = Array.from(w.channels[0]!);
    expect(ch.length).toBe(16);
    // Square at ratio 2 across 16 samples wraps every 8 samples → high for
    // first 4, low for next 4, repeated.
    expect(ch.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(4, 8)).toEqual([-1, -1, -1, -1]);
    expect(ch.slice(8, 12)).toEqual([1, 1, 1, 1]);
    expect(ch.slice(12, 16)).toEqual([-1, -1, -1, -1]);
  });

  it("ratio 1 + ratio 1 matches single-cycle behaviour", () => {
    // Sanity-check that the new code path is byte-equivalent to the old
    // single-cycle render when both ratios are at the fundamental.
    const single = generateChiptuneCycle(defaultChiptuneParams());
    const explicit = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      osc1: { ...defaultChiptuneParams().osc1, ratio: 1 },
      osc2: { ...defaultChiptuneParams().osc2, ratio: 1 },
    });
    expect(Array.from(single.channels[0]!)).toEqual(
      Array.from(explicit.channels[0]!),
    );
  });
});

describe("generateChiptuneCycle — LFO", () => {
  it("with amplitude 0 and multiplier 1, the output matches the no-LFO render", () => {
    const base = generateChiptuneCycle(defaultChiptuneParams());
    const off = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      lfo: { cycleMultiplier: 1, amplitude: 0, target: "amplitude" },
    });
    expect(Array.from(off.channels[0]!)).toEqual(Array.from(base.channels[0]!));
  });

  it("cycleMultiplier extends the rendered output length", () => {
    const m1 = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 32,
        lfo: { cycleMultiplier: 1, amplitude: 0, target: "amplitude" },
      }),
    );
    const m4 = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 32,
        lfo: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
      }),
    );
    expect(m1.channels[0]!.length).toBe(32);
    expect(m4.channels[0]!.length).toBe(128);
  });

  it("amplitude target with full amp shapes a triangle envelope on the output", () => {
    // Drive a constant +1 carrier (square at phaseSplit 0.5 always at +1 in
    // the first half — pick cycleFrames=4 with osc1=square + amp=1 +
    // multiplier=4 so we can read off the LFO envelope clearly. We compare
    // peak magnitudes near the LFO mid (high) and the LFO ends (low).
    const w = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      cycleFrames: 8,
      amplitude: 0.5, // base amp leaves headroom for the LFO to add to.
      osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // square → ±1
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
      combineMode: "morph",
      combineAmount: 0,
      lfo: { cycleMultiplier: 4, amplitude: 1, target: "amplitude" },
    });
    const ch = w.channels[0]!;
    expect(ch.length).toBe(32);
    // Mid of the LFO triangle (i = L/2) hits amp 1.0 (saturation cap),
    // start/end hit base amp 0.5.
    expect(Math.abs(ch[0]!)).toBeCloseTo(0.5, 6);
    expect(Math.abs(ch[16]!)).toBeCloseTo(1.0, 6);
    expect(Math.abs(ch[31]!)).toBeLessThan(Math.abs(ch[16]!));
  });

  it("chiptuneFromJson back-fills `lfo` for older payloads", () => {
    const restored = chiptuneFromJson({
      ...defaultChiptuneParams(),
      // Strip the lfo as if loaded from a pre-LFO `.retro` file.
      lfo: undefined,
    });
    expect(restored?.lfo).toEqual({
      cycleMultiplier: 1,
      amplitude: 0,
      target: "osc1Shape",
    });
  });
});

describe("snapLfoMultiplierToDivisor", () => {
  it("returns 1 when total is 1 (only valid divisor)", () => {
    expect(snapLfoMultiplierToDivisor(0, 1)).toBe(1);
    expect(snapLfoMultiplierToDivisor(5, 1)).toBe(1);
    expect(snapLfoMultiplierToDivisor(99, 1)).toBe(1);
  });

  it("snaps to the nearest divisor of total", () => {
    // Divisors of 12: 1, 2, 3, 4, 6, 12.
    expect(snapLfoMultiplierToDivisor(1, 12)).toBe(1);
    expect(snapLfoMultiplierToDivisor(2, 12)).toBe(2);
    expect(snapLfoMultiplierToDivisor(7, 12)).toBe(6); // closer to 6 than 12
    expect(snapLfoMultiplierToDivisor(11, 12)).toBe(12);
    expect(snapLfoMultiplierToDivisor(20, 12)).toBe(12); // out-of-range → max divisor
  });

  it("handles powers of two cleanly", () => {
    // Divisors of 64: 1, 2, 4, 8, 16, 32, 64.
    for (const d of [1, 2, 4, 8, 16, 32, 64]) {
      expect(snapLfoMultiplierToDivisor(d, 64)).toBe(d);
    }
    // Clearly-closer-to-one neighbour cases.
    expect(snapLfoMultiplierToDivisor(7, 64)).toBe(8);
    expect(snapLfoMultiplierToDivisor(15, 64)).toBe(16);
    expect(snapLfoMultiplierToDivisor(50, 64)).toBe(64);
  });

  it("breaks ties toward the smaller (earlier) divisor", () => {
    // 5 is equidistant from 4 and 6 (divisors of 12); the earlier scan
    // wins. Documented here because it could surprise — equally-near
    // divisors always pick the slower (smaller-multiplier) LFO 2.
    expect(snapLfoMultiplierToDivisor(5, 12)).toBe(4);
    expect(snapLfoMultiplierToDivisor(6, 64)).toBe(4); // 4 and 8 both dist 2
  });

  it("falls back to 1 on non-finite input", () => {
    expect(snapLfoMultiplierToDivisor(NaN, 12)).toBe(1);
    expect(snapLfoMultiplierToDivisor(Infinity, 12)).toBe(1);
  });
});

describe("generateChiptuneCycle — LFO 2", () => {
  it("renders identical output to LFO 2 disabled when amp=0, regardless of m2", () => {
    // LFO 2 with amp 0 must be a true no-op so users can park the slider
    // anywhere without affecting the audio.
    const baseline = generateChiptuneCycle(defaultChiptuneParams());
    const withInactive = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      lfo2: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
    });
    expect(Array.from(withInactive.channels[0]!)).toEqual(
      Array.from(baseline.channels[0]!),
    );
  });

  it("output length is set by LFO 1's multiplier; LFO 2 doesn't extend it", () => {
    // L = baseLen × m1 regardless of m2.
    const w = generateChiptuneCycle(
      withDefaults({
        cycleFrames: 16,
        lfo: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
        lfo2: { cycleMultiplier: 2, amplitude: 1, target: "osc1Shape" },
      }),
    );
    // baseLen=16, m1=4 → L=64. m2=2 (divisor of 4) → period2=32.
    expect(w.channels[0]!.length).toBe(64);
  });

  it("LFO 2 completes m1/m2 triangles inside the rendered output", () => {
    // amp target so we can read off the envelope. m1=4, m2=2 means
    // LFO 2 does 2 triangles in L. Each triangle is 0→1→0, so the
    // envelope returns to base-amp every period2 = baseLen × m2 samples.
    const w = generateChiptuneCycle({
      ...defaultChiptuneParams(),
      cycleFrames: 8,
      amplitude: 0.5, // headroom so LFO can lift toward 1.0
      osc1: { shapeIndex: 4, phaseSplit: 0.5, ratio: 1 }, // square → ±1
      osc2: { shapeIndex: 0, phaseSplit: 0.5, ratio: 1 },
      combineMode: "morph",
      combineAmount: 0,
      // LFO 1 silent (amp=0); we only want to see LFO 2's effect.
      lfo: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
      lfo2: { cycleMultiplier: 2, amplitude: 1, target: "amplitude" },
    });
    const ch = w.channels[0]!;
    // baseLen=8, L=32, period2=16. Two LFO 2 triangles in L:
    // i=0 → base amp 0.5, i=8 → mid of first triangle (peak 1.0),
    // i=16 → end of first triangle (back to 0.5), i=24 → mid of second (1.0).
    expect(ch.length).toBe(32);
    expect(Math.abs(ch[0]!)).toBeCloseTo(0.5, 6);
    expect(Math.abs(ch[8]!)).toBeCloseTo(1.0, 6);
    expect(Math.abs(ch[16]!)).toBeCloseTo(0.5, 6);
    expect(Math.abs(ch[24]!)).toBeCloseTo(1.0, 6);
  });

  it("renderer auto-snaps a non-divisor m2 to a divisor of m1", () => {
    // m2=5 isn't a divisor of m1=4; the renderer should snap it to one
    // (the nearest divisor of 4 to 5 is 4 itself).
    const snapped = generateChiptuneCycle(
      withDefaults({
        lfo: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
        lfo2: { cycleMultiplier: 5, amplitude: 0.5, target: "osc1Shape" },
      }),
    );
    const matched = generateChiptuneCycle(
      withDefaults({
        lfo: { cycleMultiplier: 4, amplitude: 0, target: "amplitude" },
        lfo2: { cycleMultiplier: 4, amplitude: 0.5, target: "osc1Shape" },
      }),
    );
    expect(Array.from(snapped.channels[0]!)).toEqual(
      Array.from(matched.channels[0]!),
    );
  });

  it("chiptuneFromJson back-fills `lfo2` for older payloads", () => {
    const restored = chiptuneFromJson({
      ...defaultChiptuneParams(),
      lfo2: undefined, // simulate a pre-LFO-2 saved file
    });
    expect(restored?.lfo2).toEqual({
      cycleMultiplier: 1,
      amplitude: 0,
      target: "osc1Shape",
    });
  });
});
