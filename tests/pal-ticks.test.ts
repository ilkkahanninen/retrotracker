import { describe, expect, it } from "vitest";
import {
  palTicksFromRowsSpeedTempo,
  tickHzForTempo,
} from "../src/core/mod/flatten";

describe("tickHzForTempo", () => {
  it("returns ~50 Hz at the PT default tempo (125)", () => {
    // CIA: floor(1773447 / 125) + 1 = 14188; 709379 / 14188 ≈ 50.00.
    expect(tickHzForTempo(125)).toBeCloseTo(50, 2);
  });

  it("returns ~60 Hz at tempo 150 (NTSC vsync identity)", () => {
    // floor(1773447 / 150) + 1 = 11824; 709379 / 11824 ≈ 60.00.
    expect(tickHzForTempo(150)).toBeCloseTo(60, 2);
  });

  it("scales inversely with tempo (faster tempo → more ticks/sec)", () => {
    expect(tickHzForTempo(200)).toBeGreaterThan(tickHzForTempo(125));
    expect(tickHzForTempo(64)).toBeLessThan(tickHzForTempo(125));
  });
});

describe("palTicksFromRowsSpeedTempo", () => {
  it("collapses to rows × speed at default tempo (PAL identity)", () => {
    // 16 rows × 6 ticks/row = 96 ticks at BPM 125 (≈ 50 Hz).
    expect(palTicksFromRowsSpeedTempo(16, 6, 125)).toBe(96);
  });

  it("scales down at higher tempo (same row count = fewer real seconds)", () => {
    // 16 rows × 6 ticks/row of 60 Hz time = 96/60 s, in PAL ticks: 80.
    expect(palTicksFromRowsSpeedTempo(16, 6, 150)).toBe(80);
  });

  it("scales up at lower tempo", () => {
    // At tempo 80: tickHz ≈ 32 Hz; 16 × 6 song-ticks → 96 / 32 s ≈ 3 s →
    // 150 PAL ticks. Allow ±1 for rounding.
    const result = palTicksFromRowsSpeedTempo(16, 6, 80);
    expect(result).toBeGreaterThanOrEqual(149);
    expect(result).toBeLessThanOrEqual(151);
  });

  it("is monotonic in row count and speed", () => {
    expect(palTicksFromRowsSpeedTempo(8, 6, 125)).toBe(48);
    expect(palTicksFromRowsSpeedTempo(16, 6, 125)).toBe(96);
    expect(palTicksFromRowsSpeedTempo(16, 3, 125)).toBe(48);
  });
});
