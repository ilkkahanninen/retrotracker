import { describe, expect, it } from "vitest";
import {
  detectPitch,
  detectPitchFromWav,
  frequencyToNoteCents,
} from "../src/core/audio/pitchDetect";
import type { WavData } from "../src/core/audio/wav";

/**
 * Synthesise a 1.0 s mono sine at `freq` Hz, `sr` sample rate. Phase is
 * fixed at 0 so the tests are bit-stable across runs; YIN doesn't care
 * about phase but determinism makes failure diagnosis easier.
 */
function sine(
  freq: number,
  sr: number,
  frames: number,
  phase = 0,
): Float32Array {
  const out = new Float32Array(frames);
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < frames; i++) out[i] = Math.sin(w * i + phase);
  return out;
}

function square(freq: number, sr: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const period = sr / freq;
  for (let i = 0; i < frames; i++) out[i] = i % period < period / 2 ? 1 : -1;
  return out;
}

function sawtooth(freq: number, sr: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const period = sr / freq;
  for (let i = 0; i < frames; i++) out[i] = ((i % period) / period) * 2 - 1;
  return out;
}

const SR = 44100;
const ONE_SEC = SR;

describe("detectPitch — accuracy", () => {
  // Notes from A2 (110 Hz) up to A5 (880 Hz). Octaves verify the
  // first-local-minimum rule doesn't lock onto a sub-harmonic.
  const cases = [
    { name: "A-2", hz: 110 },
    { name: "C-3", hz: 130.81 },
    { name: "E-3", hz: 164.81 },
    { name: "A-3", hz: 220 },
    { name: "C-4", hz: 261.63 },
    { name: "A-4", hz: 440 },
    { name: "C-5", hz: 523.25 },
    { name: "A-5", hz: 880 },
  ];

  for (const c of cases) {
    it(`detects ${c.name} (${c.hz} Hz) within 1 cent`, () => {
      const buf = sine(c.hz, SR, ONE_SEC);
      const r = detectPitch(buf, SR);
      expect(r).not.toBeNull();
      const err = Math.abs(r!.hz - c.hz) / c.hz;
      // 0.0006 ≈ 1 cent (2^(1/1200) - 1 ≈ 0.000578).
      expect(err).toBeLessThan(0.0006);
    });
  }
});

describe("detectPitch — detuned cents", () => {
  const base = 440;
  for (const cents of [-49, -23, -5, 5, 23, 37]) {
    it(`detects ${cents >= 0 ? "+" : ""}${cents}¢ from A-440 within ±1.5¢`, () => {
      const f = base * Math.pow(2, cents / 1200);
      const r = detectPitch(sine(f, SR, ONE_SEC), SR);
      expect(r).not.toBeNull();
      const detectedCents = 1200 * Math.log2(r!.hz / base);
      expect(Math.abs(detectedCents - cents)).toBeLessThan(1.5);
    });
  }
});

describe("detectPitch — sample-rate independence", () => {
  for (const sr of [22050, 44100, 48000]) {
    it(`works at ${sr} Hz`, () => {
      const r = detectPitch(sine(440, sr, sr), sr);
      expect(r).not.toBeNull();
      expect(Math.abs(r!.hz - 440) / 440).toBeLessThan(0.0006);
    });
  }
});

describe("detectPitch — non-sine periodicities", () => {
  it("detects a 220 Hz square wave", () => {
    const r = detectPitch(square(220, SR, ONE_SEC), SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.hz - 220) / 220).toBeLessThan(0.003); // 5 cents
  });

  it("detects a 220 Hz sawtooth", () => {
    const r = detectPitch(sawtooth(220, SR, ONE_SEC), SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.hz - 220) / 220).toBeLessThan(0.003);
  });
});

describe("detectPitch — guardrails", () => {
  it("returns null on pure silence", () => {
    const buf = new Float32Array(ONE_SEC);
    expect(detectPitch(buf, SR)).toBeNull();
  });

  it("returns null or low confidence on white noise", () => {
    // Deterministic PRNG so the test is stable.
    let s = 0x12345678;
    const rand = () => {
      s = (s * 1664525 + 1013904223) | 0;
      return (s >>> 0) / 0xffffffff;
    };
    const buf = new Float32Array(ONE_SEC);
    for (let i = 0; i < buf.length; i++) buf[i] = rand() * 2 - 1;
    const r = detectPitch(buf, SR);
    // Either null, or low confidence — never a confidently-wrong answer.
    if (r !== null) expect(r.confidence).toBeLessThan(0.7);
  });

  it("returns null when the sample is too short for any window", () => {
    const buf = sine(440, SR, 200);
    expect(detectPitch(buf, SR)).toBeNull();
  });

  it("handles a short-but-detectable sample by falling back to a smaller window", () => {
    // 4096 frames of 440 Hz at 44.1 kHz is ~93 ms. With the 10/90 trim
    // that's 3276 usable frames — below the default 4096-frame window.
    // The detector should fall back to a power-of-two window ≤ N/2.
    const buf = sine(440, SR, 4096);
    const r = detectPitch(buf, SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.hz - 440) / 440).toBeLessThan(0.005);
  });
});

describe("detectPitchFromWav — channel mixing", () => {
  it("mono and stereo with identical channels detect to the same Hz", () => {
    const ch = sine(440, SR, ONE_SEC);
    const mono: WavData = { sampleRate: SR, channels: [ch] };
    const stereo: WavData = {
      sampleRate: SR,
      channels: [ch, ch.slice()],
    };
    const a = detectPitchFromWav(mono);
    const b = detectPitchFromWav(stereo);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs(a!.hz - b!.hz)).toBeLessThan(0.01);
  });

  it("returns null for an empty WavData", () => {
    expect(detectPitchFromWav({ sampleRate: SR, channels: [] })).toBeNull();
    expect(
      detectPitchFromWav({ sampleRate: SR, channels: [new Float32Array(0)] }),
    ).toBeNull();
  });
});

describe("frequencyToNoteCents", () => {
  it("440 Hz → MIDI 69 (A-4), 0 cents", () => {
    const r = frequencyToNoteCents(440);
    expect(r.midi).toBe(69);
    expect(Math.abs(r.cents)).toBeLessThan(0.01);
  });

  it("261.63 Hz → MIDI 60 (C-4), 0 cents", () => {
    const r = frequencyToNoteCents(261.6256);
    expect(r.midi).toBe(60);
    expect(Math.abs(r.cents)).toBeLessThan(0.1);
  });

  it("a quarter-tone above A-4 → MIDI 69, ~+50¢ rounded to 70", () => {
    // 50 cents lands exactly on the rounding boundary; we don't care
    // which way it rounds — only that the cents offset is consistent
    // with the chosen MIDI value.
    const hz = 440 * Math.pow(2, 50 / 1200);
    const r = frequencyToNoteCents(hz);
    if (r.midi === 69) expect(r.cents).toBeGreaterThan(45);
    else expect(r.cents).toBeLessThan(-45);
  });

  it("split is in [-50, +50] across a sweep", () => {
    for (let cents = -49; cents <= 49; cents += 7) {
      const hz = 440 * Math.pow(2, cents / 1200);
      const r = frequencyToNoteCents(hz);
      expect(r.cents).toBeGreaterThanOrEqual(-50);
      expect(r.cents).toBeLessThanOrEqual(50);
    }
  });
});
