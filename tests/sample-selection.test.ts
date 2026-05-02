import { describe, expect, it } from 'vitest';
import { cropSample, cutSample } from '../src/core/mod/sampleSelection';
import type { Sample } from '../src/core/mod/types';

function ramp(len: number, opts: Partial<Sample> = {}): Sample {
  const data = new Int8Array(len);
  for (let i = 0; i < len; i++) data[i] = i & 0x7f; // 0..127, then wraps
  return {
    name: 't',
    lengthWords: len >> 1,
    finetune: 0,
    volume: 64,
    loopStartWords: 0,
    loopLengthWords: 1,
    data,
    ...opts,
  };
}

describe('cropSample', () => {
  it('keeps only the [start, end) byte slice', () => {
    const s = ramp(100);
    const r = cropSample(s, 20, 60)!;
    expect(r.data.byteLength).toBe(40);
    expect(r.data[0]).toBe(20);
    expect(r.data[39]).toBe(59);
  });

  it('rounds the selection inward to word boundaries', () => {
    // start=21 rounds UP to 22; end=59 rounds DOWN to 58.
    const r = cropSample(ramp(100), 21, 59)!;
    expect(r.data.byteLength).toBe(36);
    expect(r.data[0]).toBe(22);
    expect(r.data[35]).toBe(57);
  });

  it('returns null when the aligned selection is shorter than 2 bytes', () => {
    expect(cropSample(ramp(100), 50, 50)).toBeNull();
    expect(cropSample(ramp(100), 50, 51)).toBeNull(); // rounds to [50, 50)
  });

  it('translates a loop sitting entirely inside the kept range', () => {
    // Loop covers bytes 20..60 (loopStartWords=10, loopLengthWords=20).
    const s = ramp(100, { loopStartWords: 10, loopLengthWords: 20 });
    // Crop to bytes 16..70 — new origin is byte 16 (= word 8).
    const r = cropSample(s, 16, 70)!;
    expect(r.loopStartWords).toBe(2);   // 10 - 8
    expect(r.loopLengthWords).toBe(20); // unchanged
  });

  it('clamps a loop that overruns the new end', () => {
    // Loop covers bytes 60..100 (loopStartWords=30, loopLengthWords=20).
    const s = ramp(100, { loopStartWords: 30, loopLengthWords: 20 });
    // Crop to bytes 0..80 — new lengthWords=40; old loop end (100) overruns 80.
    const r = cropSample(s, 0, 80)!;
    expect(r.loopStartWords).toBe(30);
    // Old end 100 → translated 100 → clamped to new lengthBytes 80 → 40 words.
    // newLoopLen = 40 - 30 = 10.
    expect(r.loopLengthWords).toBe(10);
  });

  it('drops the loop entirely when the kept range falls outside it', () => {
    const s = ramp(100, { loopStartWords: 30, loopLengthWords: 20 });
    // Crop to bytes 0..40 — loop sits beyond.
    const r = cropSample(s, 0, 40)!;
    expect(r.loopStartWords).toBe(0);
    expect(r.loopLengthWords).toBe(1);
  });

  it('leaves loop=(0,1) for samples that were not looped', () => {
    const r = cropSample(ramp(100), 10, 30)!;
    expect(r.loopStartWords).toBe(0);
    expect(r.loopLengthWords).toBe(1);
  });
});

describe('cutSample', () => {
  it('removes [start, end) and concatenates the rest', () => {
    const s = ramp(100);
    const r = cutSample(s, 30, 50)!;
    expect(r.data.byteLength).toBe(80);
    // First 30 bytes preserved, then bytes 50..99.
    expect(r.data[0]).toBe(0);
    expect(r.data[29]).toBe(29);
    expect(r.data[30]).toBe(50);
    expect(r.data[79]).toBe(99);
  });

  it('preserves a loop sitting entirely BEFORE the cut', () => {
    const s = ramp(100, { loopStartWords: 5, loopLengthWords: 5 });
    // Loop covers bytes 10..20; cut bytes 40..60.
    const r = cutSample(s, 40, 60)!;
    expect(r.loopStartWords).toBe(5);
    expect(r.loopLengthWords).toBe(5);
  });

  it('shifts a loop that sits entirely AFTER the cut left by the cut size', () => {
    const s = ramp(100, { loopStartWords: 35, loopLengthWords: 10 });
    // Loop covers bytes 70..90; cut bytes 20..40 (20 bytes = 10 words).
    const r = cutSample(s, 20, 40)!;
    expect(r.loopStartWords).toBe(25); // 35 - 10
    expect(r.loopLengthWords).toBe(10);
  });

  it('clears a loop that overlaps the cut region', () => {
    const s = ramp(100, { loopStartWords: 10, loopLengthWords: 20 });
    // Loop covers bytes 20..60; cut bytes 30..50 — overlaps.
    const r = cutSample(s, 30, 50)!;
    expect(r.loopStartWords).toBe(0);
    expect(r.loopLengthWords).toBe(1);
  });

  it('returns null for an empty selection', () => {
    expect(cutSample(ramp(100), 50, 50)).toBeNull();
  });
});
