import { describe, expect, it } from "vitest";

import { writeWav } from "~/core/audio/wav";
import {
  deriveXmSampleName,
  importWavXmSample,
  wavToXmSampleData,
} from "~/core/xm/sampleImport";

describe("deriveXmSampleName", () => {
  it("strips path and extension, ASCII-cleans, truncates to 22 chars", () => {
    expect(deriveXmSampleName("/dir/file.wav")).toBe("file");
    expect(deriveXmSampleName("kick.WAV")).toBe("kick");
    expect(deriveXmSampleName("12345678901234567890123456789.wav")).toBe(
      "1234567890123456789012",
    );
  });
});

describe("wavToXmSampleData", () => {
  it("quantises mono float to int8 with symmetric peak", () => {
    // 0.5 * 127 = 63.5 → 64 (Math.round rounds toward +∞ at .5).
    // -0.5 * 127 = -63.5 → -63 (same rule, toward zero on the negative
    // side). The asymmetry is a known JS Math.round quirk; it's
    // ±0.5/127 ≈ 0.4% off and inaudible.
    const ch = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const data = wavToXmSampleData({ sampleRate: 44100, channels: [ch] }, 8);
    expect(data).toBeInstanceOf(Int8Array);
    expect(Array.from(data)).toEqual([0, 64, -63, 127, -127]);
  });

  it("quantises mono float to int16 with full dynamic range", () => {
    const ch = new Float32Array([0, 0.5, -0.5, 1]);
    const data = wavToXmSampleData({ sampleRate: 44100, channels: [ch] }, 16);
    expect(data).toBeInstanceOf(Int16Array);
    expect(Array.from(data)).toEqual([0, 16384, -16383, 32767]);
  });

  it("downmixes stereo to mono", () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([-1, 0, 1]);
    const data = wavToXmSampleData({ sampleRate: 44100, channels: [l, r] }, 8);
    // Both channels cancel exactly → zeros.
    expect(Array.from(data)).toEqual([0, 0, 0]);
  });
});

describe("importWavXmSample", () => {
  it("round-trips an 8-bit-style WAV to an 8-bit XmSample", () => {
    const ch = new Float32Array(16);
    for (let i = 0; i < 16; i++) ch[i] = i / 16 - 0.5;
    const wav = writeWav({ sampleRate: 44100, channels: [ch] });
    const result = importWavXmSample(new Uint8Array(wav), "kick.wav", {
      bits: 8,
    });
    expect(result.sample.bits).toBe(8);
    expect(result.sample.data).toBeInstanceOf(Int8Array);
    expect(result.sample.data.length).toBe(16);
    expect(result.sample.loopType).toBe("none");
    expect(result.sample.name).toBe("kick");
    expect(result.sourceSampleRate).toBe(44100);
  });

  it("defaults to 16-bit when no `bits` override is provided", () => {
    const ch = new Float32Array([0.5]);
    const wav = writeWav({ sampleRate: 22050, channels: [ch] });
    const result = importWavXmSample(new Uint8Array(wav), "sound.wav");
    expect(result.sample.bits).toBe(16);
    expect(result.sample.data).toBeInstanceOf(Int16Array);
    expect(result.sample.data[0]).toBe(16384);
  });
});
