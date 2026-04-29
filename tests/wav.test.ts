import { describe, expect, it } from 'vitest';
import { readWav, writeWav } from './lib/wav';
import { compareChannels } from './lib/compare';

describe('WAV round-trip', () => {
  it('writes and reads 16-bit stereo', () => {
    const frames = 1024;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
      right[i] = Math.sin((2 * Math.PI * 660 * i) / 44100);
    }

    const buf = writeWav({ sampleRate: 44100, channels: [left, right] });
    const decoded = readWav(buf);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels).toHaveLength(2);

    const result = compareChannels([left, right], decoded.channels);
    // 16-bit quantization noise floor is well below 1e-3 RMS for a sine.
    for (const rms of result.rmsDiff) expect(rms).toBeLessThan(1e-3);
    for (const peak of result.peakDiff) expect(peak).toBeLessThan(1e-3);
  });

  it('writes and reads 24-bit mono', () => {
    const frames = 512;
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = (i / frames) * 2 - 1;

    const buf = writeWav({ sampleRate: 48000, channels: [ch] }, { bitsPerSample: 24 });
    const decoded = readWav(buf);
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels).toHaveLength(1);
    const r = compareChannels([ch], decoded.channels);
    expect(r.peakDiff[0]!).toBeLessThan(1e-6);
  });
});
