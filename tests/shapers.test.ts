import { describe, expect, it } from "vitest";
import {
  applyShaper,
  SHAPER_MODES,
  type ShaperMode,
} from "../src/core/audio/shapers";

const NON_BYPASS: readonly Exclude<ShaperMode, "none">[] = SHAPER_MODES.filter(
  (m): m is Exclude<ShaperMode, "none"> => m !== "none",
);

describe("applyShaper", () => {
  it("'none' is a literal passthrough at any amount", () => {
    for (const a of [0, 0.3, 1]) {
      for (const x of [-1, -0.5, 0, 0.25, 1]) {
        expect(applyShaper(x, "none", a)).toBe(x);
      }
    }
  });

  it("every mode is a near-bypass at amount=0 for in-range input", () => {
    // Bitcrush quantises to 256 levels at a=0 — well below int8 resolution
    // downstream, so a 1/256 deviation counts as bypass for our purposes.
    for (const mode of NON_BYPASS) {
      for (const x of [-0.9, -0.4, 0, 0.4, 0.9]) {
        const y = applyShaper(x, mode, 0);
        expect(Math.abs(y - x)).toBeLessThan(1 / 200);
      }
    }
  });

  it("every mode keeps output inside [-1, 1] for in-range input across the amount sweep", () => {
    for (const mode of SHAPER_MODES) {
      for (let a = 0; a <= 1; a += 0.1) {
        for (const x of [-1, -0.7, -0.3, 0, 0.3, 0.7, 1]) {
          const y = applyShaper(x, mode, a);
          expect(y).toBeGreaterThanOrEqual(-1.0000001);
          expect(y).toBeLessThanOrEqual(1.0000001);
        }
      }
    }
  });

  it("hardClip at a=1 saturates a small input to ±1", () => {
    // drive=9 at a=1 → 0.5 * 9 = 4.5 → clamp to 1
    expect(applyShaper(0.5, "hardClip", 1)).toBe(1);
    expect(applyShaper(-0.5, "hardClip", 1)).toBe(-1);
  });

  it("softClip at a=1 leaves the input bounded but smoothly compressed", () => {
    // tanh(5*0.5)/tanh(5) ≈ 0.987 — close to 1 but not clipped
    const y = applyShaper(0.5, "softClip", 1);
    expect(y).toBeGreaterThan(0.95);
    expect(y).toBeLessThan(1);
  });

  it("wavefold at a=1 folds an over-driven signal back into [-1, 1]", () => {
    // drive=6 at a=1; for x=0.5, y=3.0, fold→-1 (third zero crossing).
    expect(applyShaper(0.5, "wavefold", 1)).toBeCloseTo(-1, 6);
    // Origin still maps to 0 across the entire sweep (odd symmetry).
    for (let a = 0; a <= 1; a += 0.25) {
      expect(applyShaper(0, "wavefold", a)).toBeCloseTo(0, 9);
    }
  });

  it("chebyshev at a=0 returns T1 (= x), at a=1 returns T7", () => {
    for (const x of [-0.8, -0.3, 0.3, 0.8]) {
      expect(applyShaper(x, "chebyshev", 0)).toBeCloseTo(x, 9);
      // T7(x) via the recurrence at x=0.3 ≈ -0.6182
      // T7(x) = 64x^7 - 112x^5 + 56x^3 - 7x
      const t7 = 64 * x ** 7 - 112 * x ** 5 + 56 * x ** 3 - 7 * x;
      expect(applyShaper(x, "chebyshev", 1)).toBeCloseTo(t7, 6);
    }
  });

  it("bitcrush at a=1 quantises to 2 levels (true ±1 square)", () => {
    // step = 2/(2-1) = 2. Anything ≥0 rounds up to +1, anything <0 to −1.
    expect(applyShaper(0.4, "bitcrush", 1)).toBe(1);
    expect(applyShaper(-0.4, "bitcrush", 1)).toBe(-1);
    expect(applyShaper(0.0001, "bitcrush", 1)).toBe(1);
    expect(applyShaper(-0.0001, "bitcrush", 1)).toBe(-1);
  });
});
