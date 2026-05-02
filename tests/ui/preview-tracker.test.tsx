import { describe, expect, it } from 'vitest';
import { createEffect, createRoot } from 'solid-js';
import { previewFrame, startPreview, stopPreview } from '../../src/state/preview';
import type { Sample } from '../../src/core/mod/types';

function makeSample(len: number, loopLengthWords = 1): Sample {
  return {
    name: 't',
    lengthWords: len >> 1,
    finetune: 0,
    volume: 64,
    loopStartWords: 0,
    loopLengthWords,
    data: new Int8Array(len),
  };
}

async function collectFrames(sample: Sample, durationMs: number): Promise<number[]> {
  const seen: number[] = [];
  const dispose = createRoot((d) => {
    createEffect(() => {
      const pf = previewFrame();
      if (pf) seen.push(pf.frame);
    });
    return d;
  });
  startPreview(0, sample, 428); // C-2, paulaRate ~8287
  await new Promise(r => setTimeout(r, durationMs));
  stopPreview();
  dispose();
  return seen;
}

describe('preview tracker', () => {
  // Regression: loopLengthWords === 1 is PT's no-loop sentinel; treating it
  // as a 2-byte loop pinned the playhead at frame 0.
  it('a sample with loopLengthWords=1 plays through without wrapping at the start', async () => {
    const frames = await collectFrames(makeSample(100000, 1), 200);
    // Frames must advance — not just stay at 0 because of a fake 2-byte loop.
    expect(frames.length).toBeGreaterThan(2);
    expect(Math.max(...frames)).toBeGreaterThan(1000);
  });

  it('a real loop (loopLengthWords > 1) wraps the playhead within the loop region', async () => {
    // Tight loop near the start: 0..200 bytes (loopStartWords=0, loopLengthWords=100 → 200 bytes).
    const frames = await collectFrames(makeSample(100000, 100), 200);
    // Past loop, frames must keep churning but stay within 0..200.
    const lateFrames = frames.slice(5);
    expect(lateFrames.length).toBeGreaterThan(2);
    for (const f of lateFrames) expect(f).toBeLessThan(200);
  });
});
