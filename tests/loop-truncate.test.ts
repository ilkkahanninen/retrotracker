import { describe, it, expect } from 'vitest';
import { truncateSampleAtLoopEnd, songForPlayback } from '../src/core/audio/loopTruncate';
import { emptySong } from '../src/core/mod/format';
import type { Sample } from '../src/core/mod/types';

function ramp(lengthWords: number, opts: Partial<Sample> = {}): Sample {
  const data = new Int8Array(lengthWords * 2);
  for (let i = 0; i < data.length; i++) data[i] = i & 0x7f;
  return {
    name: 't', volume: 64, finetune: 0,
    lengthWords,
    loopStartWords: 0, loopLengthWords: 1,
    data,
    ...opts,
  };
}

describe('truncateSampleAtLoopEnd', () => {
  it('drops bytes after loopEnd when the sample is looped and loopEnd < sampleEnd', () => {
    const s = ramp(16, { loopStartWords: 0, loopLengthWords: 8 });
    const out = truncateSampleAtLoopEnd(s);
    expect(out).not.toBe(s);
    // Loop covers words 0..8 = bytes 0..16; trailing bytes 16..31 dropped.
    expect(out.data.byteLength).toBe(16);
    expect(out.lengthWords).toBe(8);
    // Kept bytes are the original 0..15 — not the trailing portion.
    expect(Array.from(out.data.slice(0, 4))).toEqual([0, 1, 2, 3]);
    // Loop fields unchanged.
    expect(out.loopStartWords).toBe(0);
    expect(out.loopLengthWords).toBe(8);
  });

  it('truncates with a non-zero loopStart too', () => {
    const s = ramp(16, { loopStartWords: 4, loopLengthWords: 6 });
    const out = truncateSampleAtLoopEnd(s);
    // loopEnd = words 10 = bytes 20.
    expect(out.data.byteLength).toBe(20);
    expect(out.lengthWords).toBe(10);
    expect(out.loopStartWords).toBe(4);
    expect(out.loopLengthWords).toBe(6);
  });

  it('returns the same reference when the sample is not looped', () => {
    const s = ramp(16, { loopStartWords: 0, loopLengthWords: 1 });
    expect(truncateSampleAtLoopEnd(s)).toBe(s);
  });

  it('returns the same reference when loopEnd already equals sampleEnd', () => {
    const s = ramp(16, { loopStartWords: 0, loopLengthWords: 16 });
    expect(truncateSampleAtLoopEnd(s)).toBe(s);
  });

  it('returns the same reference when loopEnd > sampleEnd (caller is responsible for clamping; we just don\'t pad)', () => {
    const s = ramp(8, { loopStartWords: 0, loopLengthWords: 16 });
    expect(truncateSampleAtLoopEnd(s)).toBe(s);
  });
});

describe('songForPlayback', () => {
  it('truncates each populated sample without mutating the input song', () => {
    const original = emptySong();
    const looped = ramp(16, { loopStartWords: 0, loopLengthWords: 8 });
    const noLoop = ramp(8);
    original.samples[0] = looped;
    original.samples[1] = noLoop;

    const out = songForPlayback(original);
    expect(out).not.toBe(original);
    expect(out.samples[0]).not.toBe(looped);
    expect(out.samples[0]!.data.byteLength).toBe(16); // truncated
    expect(out.samples[1]).toBe(noLoop);              // unchanged

    // Original song untouched.
    expect(original.samples[0]).toBe(looped);
    expect(original.samples[0]!.data.byteLength).toBe(32);
  });
});
