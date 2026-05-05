import { describe, expect, it } from "vitest";
import {
  deriveSampleName,
  importWavSample,
  wavToInt8Mono,
} from "../src/core/mod/sampleImport";
import { writeWav } from "../src/core/audio/wav";

describe("deriveSampleName", () => {
  it("strips path and extension", () => {
    expect(deriveSampleName("/tmp/Sounds/snare.wav")).toBe("snare");
    expect(deriveSampleName("C:\\Sounds\\kick.WAV")).toBe("kick");
    expect(deriveSampleName("plain.wav")).toBe("plain");
  });

  it("keeps a name with no extension as-is", () => {
    expect(deriveSampleName("hat")).toBe("hat");
  });

  it("treats a leading dot as separating an empty stem from the extension", () => {
    expect(deriveSampleName(".wav")).toBe("");
  });

  it("truncates to the 22-char PT name limit", () => {
    expect(deriveSampleName("a-very-long-filename-indeed.wav")).toBe(
      "a-very-long-filename-i",
    );
  });

  it("replaces non-printable characters with underscores", () => {
    expect(deriveSampleName("snäre.wav")).toBe("sn_re");
  });

  it('returns "" for paths that boil down to nothing usable', () => {
    expect(deriveSampleName(".wav")).toBe("");
  });
});

describe("wavToInt8Mono", () => {
  it("quantises a single Float32 channel to int8", () => {
    const channels = [new Float32Array([0, 1, -1, 0.5, -0.5])];
    const out = wavToInt8Mono({ sampleRate: 44100, channels });
    // ±1 maps to ±127 (symmetric range so the quantised int8 is balanced).
    // ±0.5 lands at ±~64 (JS Math.round rounds halves toward +∞ — so +0.5 → 64,
    // -0.5 → -63 — a one-step rounding asymmetry that doesn't affect audio).
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(127);
    expect(out[2]).toBe(-127);
    expect(out[3]).toBe(64);
    expect(out[4]).toBe(-63);
  });

  it("clamps out-of-range floats before quantising", () => {
    const channels = [new Float32Array([2, -2])];
    const out = wavToInt8Mono({ sampleRate: 44100, channels });
    expect(Array.from(out)).toEqual([127, -127]);
  });

  it("averages stereo channels frame-by-frame", () => {
    const channels = [
      new Float32Array([1, 0, -1]),
      new Float32Array([-1, 0, 1]),
    ];
    const out = wavToInt8Mono({ sampleRate: 44100, channels });
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it("handles empty input gracefully", () => {
    expect(wavToInt8Mono({ sampleRate: 44100, channels: [] }).length).toBe(0);
  });
});

describe("importWavSample (round-trip from a synthetic WAV)", () => {
  it("parses a 16-bit mono WAV into the expected int8 mono data", () => {
    const channels = [new Float32Array([0, 1, 0, -1, 0])];
    const wav = writeWav(
      { sampleRate: 22050, channels },
      { bitsPerSample: 16 },
    );
    const result = importWavSample(wav, "beep.wav");
    expect(result.sourceSampleRate).toBe(22050);
    expect(result.name).toBe("beep");
    // 16→8 + clamp drops a tiny amount of precision; ±1 of nominal is fine.
    expect(result.data.length).toBe(5);
    expect(result.data[0]).toBe(0);
    expect(Math.abs(result.data[1]! - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.data[3]! - -127)).toBeLessThanOrEqual(1);
  });

  it("mixes a stereo WAV down to mono", () => {
    // Two opposite-phase channels — average should be silence.
    const channels = [
      new Float32Array([0.5, 0.5, 0.5]),
      new Float32Array([-0.5, -0.5, -0.5]),
    ];
    const wav = writeWav(
      { sampleRate: 44100, channels },
      { bitsPerSample: 16 },
    );
    const result = importWavSample(wav, "cancels.wav");
    for (const v of result.data) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});
