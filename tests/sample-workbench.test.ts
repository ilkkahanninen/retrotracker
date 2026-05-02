import { describe, expect, it } from 'vitest';
import {
  applyGain, applyNormalize, applyReverse, applyCrop,
  applyFadeIn, applyFadeOut, applyEffect,
  runChain, transformToPt, runPipeline,
  workbenchFromWav, defaultEffect,
  resampleLinear, rateForTargetNote, DEFAULT_TARGET_NOTE,
  type SampleWorkbench,
} from '../src/core/audio/sampleWorkbench';
import { writeWav } from '../src/core/audio/wav';

const sr = 44100;

function mono(...vs: number[]) {
  return { sampleRate: sr, channels: [Float32Array.from(vs)] };
}
function stereo(L: number[], R: number[]) {
  return { sampleRate: sr, channels: [Float32Array.from(L), Float32Array.from(R)] };
}

describe('applyGain', () => {
  it('multiplies every sample on every channel', () => {
    // Pick f32-exact fractions (powers of 2) so the assertion isn't fragile.
    const out = applyGain(stereo([0.125, 0.25], [-0.5, 0.0625]), 2);
    expect(Array.from(out.channels[0]!)).toEqual([0.25, 0.5]);
    expect(Array.from(out.channels[1]!)).toEqual([-1, 0.125]);
  });

  it('returns the same WavData reference when gain is 1 (noop short-circuit)', () => {
    const w = mono(0.5);
    expect(applyGain(w, 1)).toBe(w);
  });
});

describe('applyNormalize', () => {
  it('scales the global peak to ±1', () => {
    const out = applyNormalize(stereo([0.3, -0.5], [0.1, 0.4]));
    // Peak is 0.5; scale factor 2.
    expect(out.channels[0]![1]!).toBeCloseTo(-1, 5);
    expect(out.channels[1]![0]!).toBeCloseTo(0.2, 5);
  });

  it('leaves silence alone', () => {
    const w = mono(0, 0, 0);
    expect(applyNormalize(w)).toBe(w);
  });
});

describe('applyReverse', () => {
  it('reverses each channel independently', () => {
    const out = applyReverse(stereo([1, 2, 3], [4, 5, 6]));
    expect(Array.from(out.channels[0]!)).toEqual([3, 2, 1]);
    expect(Array.from(out.channels[1]!)).toEqual([6, 5, 4]);
  });
});

describe('applyCrop', () => {
  it('slices [start, end)', () => {
    const out = applyCrop(mono(0, 1, 2, 3, 4), 1, 4);
    expect(Array.from(out.channels[0]!)).toEqual([1, 2, 3]);
  });

  it('clamps out-of-range indexes', () => {
    const out = applyCrop(mono(0, 1, 2), -10, 100);
    expect(Array.from(out.channels[0]!)).toEqual([0, 1, 2]);
  });

  it('returns the same reference when crop covers the whole input', () => {
    const w = mono(0, 1, 2);
    expect(applyCrop(w, 0, 3)).toBe(w);
  });
});

describe('applyFadeIn / applyFadeOut', () => {
  it('fade-in ramps from 0 to 1 over the requested frame count', () => {
    const out = applyFadeIn(mono(1, 1, 1, 1, 1), 4);
    const ch = out.channels[0]!;
    expect(ch[0]).toBe(0);
    expect(ch[1]).toBeCloseTo(0.25, 5);
    expect(ch[2]).toBeCloseTo(0.5, 5);
    expect(ch[3]).toBeCloseTo(0.75, 5);
    expect(ch[4]).toBe(1);
  });

  it('fade-out ramps from 1 to 0 over the last N frames', () => {
    const out = applyFadeOut(mono(1, 1, 1, 1, 1), 4);
    const ch = out.channels[0]!;
    expect(ch[0]).toBe(1);
    expect(ch[1]).toBeCloseTo(1, 5);
    expect(ch[2]).toBeCloseTo(0.75, 5);
    expect(ch[3]).toBeCloseTo(0.5, 5);
    expect(ch[4]).toBeCloseTo(0.25, 5);
  });

  it('frames=0 is a noop', () => {
    const w = mono(1, 1, 1);
    expect(applyFadeIn(w, 0)).toBe(w);
    expect(applyFadeOut(w, 0)).toBe(w);
  });
});

describe('runChain', () => {
  it('runs effects in order', () => {
    const out = runChain(mono(0.25, -0.5, 0.5), [
      { kind: 'gain', params: { gain: 2 } },     // ×2 → 0.5, -1, 1
      { kind: 'reverse' },                        // → 1, -1, 0.5
    ]);
    expect(Array.from(out.channels[0]!)).toEqual([1, -1, 0.5]);
  });

  it('returns the source unchanged when the chain is empty', () => {
    const w = mono(0.1, 0.2);
    const out = runChain(w, []);
    expect(out).toBe(w);
  });
});

describe('transformToPt (mono mix + int8 quantise)', () => {
  it('passes through a mono source', () => {
    const out = transformToPt(mono(0, 1, -1), { monoMix: 'average', targetNote: null });
    expect(Array.from(out)).toEqual([0, 127, -127]);
  });

  it('mono mix = average sums and divides stereo', () => {
    const out = transformToPt(stereo([1, 0], [-1, 0]), { monoMix: 'average', targetNote: null });
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it('mono mix = left picks just the left channel', () => {
    const out = transformToPt(stereo([1, 0.5], [-1, -0.5]), { monoMix: 'left', targetNote: null });
    expect(Array.from(out)).toEqual([127, 64]);
  });

  it('mono mix = right picks just the right channel', () => {
    const out = transformToPt(stereo([1, 0.5], [-1, -0.5]), { monoMix: 'right', targetNote: null });
    expect(Array.from(out)).toEqual([-127, -63]);
  });
});

describe('runPipeline (end-to-end)', () => {
  it('source → chain → PT transformer → Int8', () => {
    const wb: SampleWorkbench = {
      source: stereo([0.5, 0.5], [-0.5, -0.5]),
      sourceName: 'demo',
      chain: [{ kind: 'gain', params: { gain: 2 } }], // → 1, 1 / -1, -1
      pt: { monoMix: 'average', targetNote: null },                      // → 0, 0
    };
    const out = runPipeline(wb);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it('with no effects, passes the source straight through to int8', () => {
    const wb: SampleWorkbench = {
      source: mono(0, 1, -1),
      sourceName: 'demo',
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
    };
    expect(Array.from(runPipeline(wb))).toEqual([0, 127, -127]);
  });
});

describe('workbenchFromWav (round-trip from a synthetic WAV)', () => {
  it('decodes the WAV into a workbench with empty chain + average monoMix + C-2 target', () => {
    const wav = writeWav({
      sampleRate: 22050,
      channels: [new Float32Array([0, 0.5, -0.5])],
    }, { bitsPerSample: 16 });
    const wb = workbenchFromWav(wav, 'beep.wav');
    expect(wb.source.sampleRate).toBe(22050);
    expect(wb.source.channels).toHaveLength(1);
    expect(wb.chain).toEqual([]);
    expect(wb.pt.monoMix).toBe('average');
    expect(wb.pt.targetNote).toBe(DEFAULT_TARGET_NOTE); // C-2 = 12
    expect(wb.sourceName).toBe('beep');
  });
});

describe('rateForTargetNote', () => {
  // PAULA_CLOCK_PAL = 7093790; rate = 7093790 / 2 / period.
  it('returns ~8287 Hz for C-2 (period 428)', () => {
    expect(rateForTargetNote(12)!).toBeCloseTo(3546895 / 428, 2);
  });
  it('returns ~16574 Hz for C-3 (period 214)', () => {
    expect(rateForTargetNote(24)!).toBeCloseTo(3546895 / 214, 2);
  });
  it('returns null for an out-of-range note slot', () => {
    expect(rateForTargetNote(99)).toBeNull();
    expect(rateForTargetNote(-1)).toBeNull();
  });
});

describe('resampleLinear', () => {
  it('passes the input through when from === to', () => {
    const buf = Float32Array.from([0, 1, -1]);
    expect(resampleLinear(buf, 44100, 44100)).toBe(buf);
  });

  it('halves the length when downsampling 2:1', () => {
    const buf = Float32Array.from([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
    const out = resampleLinear(buf, 88200, 44100);
    expect(out.length).toBe(4);
    // First, third, fifth, seventh sample.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(-1);
  });

  it('doubles the length when upsampling 1:2 with linear interpolation', () => {
    const buf = Float32Array.from([0, 1, 0]);
    const out = resampleLinear(buf, 22050, 44100);
    expect(out.length).toBe(6);
    // Mid-points are average of neighbours.
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(1, 5);
    expect(out[3]).toBeCloseTo(0.5, 5);
    expect(out[4]).toBe(0);
  });

  it('always emits at least one frame for non-empty input', () => {
    const buf = Float32Array.from([0.5]);
    const out = resampleLinear(buf, 44100, 8287); // ratio 5.32 → length 0.19
    expect(out.length).toBe(1);
  });

  it('preserves an empty input as an empty output', () => {
    expect(resampleLinear(new Float32Array(0), 44100, 8287).length).toBe(0);
  });
});

describe('transformToPt with targetNote', () => {
  it('null targetNote leaves the source rate alone (no resample)', () => {
    const audio = { sampleRate: 44100, channels: [new Float32Array([0, 1, -1])] };
    const out = transformToPt(audio, { monoMix: 'average', targetNote: null });
    expect(out.length).toBe(3); // unchanged
  });

  it('resamples to the target note rate before quantising', () => {
    // Build a 256-frame source at 44.1 kHz; with target=C-2 the rate becomes
    // ~8287 Hz and we expect ~256 * 8287/44100 ≈ 48 frames.
    const audio = {
      sampleRate: 44100,
      channels: [new Float32Array(256).fill(1)],
    };
    const out = transformToPt(audio, { monoMix: 'average', targetNote: 12 });
    expect(out.length).toBeGreaterThan(40);
    expect(out.length).toBeLessThan(60);
    // All input samples were +1 → all output samples should be ~127.
    expect(out[0]).toBe(127);
    expect(out[10]).toBe(127);
  });

  it('runPipeline default (C-2) downsamples a 44.1 kHz source', () => {
    const wav = writeWav({
      sampleRate: 44100,
      channels: [new Float32Array(256).fill(0.5)],
    }, { bitsPerSample: 16 });
    const wb = workbenchFromWav(wav, 'tone.wav');
    expect(wb.pt.targetNote).toBe(12);
    const out = runPipeline(wb);
    // ~256 frames at 44100 → ~48 frames at 8287.
    expect(out.length).toBeGreaterThan(40);
    expect(out.length).toBeLessThan(60);
  });
});

describe('defaultEffect (UI factory)', () => {
  it('crop defaults to the full source range', () => {
    const src = mono(...new Array(100).fill(0));
    const e = defaultEffect('crop', src);
    expect(e.kind).toBe('crop');
    if (e.kind === 'crop') {
      expect(e.params.startFrame).toBe(0);
      expect(e.params.endFrame).toBe(100);
    }
  });

  it('gain defaults to ×1 (audibly identity)', () => {
    const e = defaultEffect('gain', mono(0));
    if (e.kind === 'gain') expect(e.params.gain).toBe(1);
  });
});

describe('applyEffect dispatcher', () => {
  it('dispatches each kind to its specialised function', () => {
    expect(applyEffect(mono(1, -1), { kind: 'gain', params: { gain: 0.5 } })
      .channels[0]).toEqual(Float32Array.from([0.5, -0.5]));
    expect(applyEffect(mono(1, 2, 3), { kind: 'reverse' })
      .channels[0]).toEqual(Float32Array.from([3, 2, 1]));
  });
});
