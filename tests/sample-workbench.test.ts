import { describe, expect, it } from 'vitest';
import {
  applyGain, applyNormalize, applyReverse, applyCrop, applyCut,
  applyFadeIn, applyFadeOut, applyFilter, applyCrossfade, applyEffect,
  applyShaperEffect,
  runChain, transformToPt, runPipeline,
  workbenchFromWav, workbenchFromInt8, workbenchFromChiptune, workbenchToAlt, defaultEffect,
  resampleLinear, resampleFilteredLinear, resampleSinc,
  rateForTargetNote, DEFAULT_TARGET_NOTE,
  RESAMPLE_MODES, RESAMPLE_LABELS, DEFAULT_RESAMPLE_MODE,
  materializeSource, sourceDisplayName, sourceWantsFullLoop,
  EFFECT_KINDS, EFFECT_LABELS,
  type SampleWorkbench,
} from '../src/core/audio/sampleWorkbench';
import { defaultChiptuneParams } from '../src/core/audio/chiptune';
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
  it('reverses the [start, end) range, leaves the rest untouched', () => {
    const out = applyReverse(mono(1, 2, 3, 4, 5), 1, 4);
    // [2,3,4] flips → [4,3,2]; head and tail untouched.
    expect(Array.from(out.channels[0]!)).toEqual([1, 4, 3, 2, 5]);
  });

  it('reverses each channel independently when the range covers the whole input', () => {
    const out = applyReverse(stereo([1, 2, 3], [4, 5, 6]), 0, 3);
    expect(Array.from(out.channels[0]!)).toEqual([3, 2, 1]);
    expect(Array.from(out.channels[1]!)).toEqual([6, 5, 4]);
  });

  it('returns the same reference when the range is shorter than 2 frames', () => {
    const w = mono(1, 2, 3);
    expect(applyReverse(w, 1, 1)).toBe(w);
    expect(applyReverse(w, 2, 2)).toBe(w);
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

describe('applyCut', () => {
  it('removes [start, end) and concatenates the rest', () => {
    const out = applyCut(mono(0, 1, 2, 3, 4, 5), 2, 4);
    expect(Array.from(out.channels[0]!)).toEqual([0, 1, 4, 5]);
  });

  it('cuts each channel independently', () => {
    const out = applyCut(stereo([0, 1, 2, 3], [10, 20, 30, 40]), 1, 3);
    expect(Array.from(out.channels[0]!)).toEqual([0, 3]);
    expect(Array.from(out.channels[1]!)).toEqual([10, 40]);
  });

  it('clamps out-of-range indexes', () => {
    const out = applyCut(mono(0, 1, 2), -10, 100);
    expect(out.channels[0]!.length).toBe(0);
  });

  it('returns the same reference when the cut is empty', () => {
    const w = mono(0, 1, 2);
    expect(applyCut(w, 1, 1)).toBe(w);
  });
});

describe('applyFadeIn / applyFadeOut', () => {
  it('fade-in ramps from 0 to 1 over [start, end), leaves the tail untouched', () => {
    // start=0, end=4 — same as the old `frames=4` form on a length-5 input.
    const out = applyFadeIn(mono(1, 1, 1, 1, 1), 0, 4);
    const ch = out.channels[0]!;
    expect(ch[0]).toBe(0);
    expect(ch[1]).toBeCloseTo(0.25, 5);
    expect(ch[2]).toBeCloseTo(0.5, 5);
    expect(ch[3]).toBeCloseTo(0.75, 5);
    expect(ch[4]).toBe(1);  // outside the range — untouched
  });

  it('fade-in over a middle range only modulates within the range', () => {
    const out = applyFadeIn(mono(1, 1, 1, 1, 1), 1, 3);
    const ch = out.channels[0]!;
    expect(ch[0]).toBe(1);   // before start — untouched
    expect(ch[1]).toBe(0);   // ramp start
    expect(ch[2]).toBeCloseTo(0.5, 5);
    expect(ch[3]).toBe(1);   // after end — untouched
    expect(ch[4]).toBe(1);
  });

  it('fade-out ramps from 1 to 0 over [start, end), leaves the head untouched', () => {
    // start=1, end=5 — same as the old `frames=4` tail form on a length-5 input.
    const out = applyFadeOut(mono(1, 1, 1, 1, 1), 1, 5);
    const ch = out.channels[0]!;
    expect(ch[0]).toBe(1);   // before start — untouched
    expect(ch[1]).toBeCloseTo(1, 5);
    expect(ch[2]).toBeCloseTo(0.75, 5);
    expect(ch[3]).toBeCloseTo(0.5, 5);
    expect(ch[4]).toBeCloseTo(0.25, 5);
  });

  it('empty range is a noop', () => {
    const w = mono(1, 1, 1);
    expect(applyFadeIn(w, 0, 0)).toBe(w);
    expect(applyFadeOut(w, 1, 1)).toBe(w);
  });
});

describe('applyFilter', () => {
  // Quick smoke test — drive a sine at fc/4 (well below cutoff) through a
  // low-pass and confirm the output stays close to the input. With a Q of
  // 0.707 the response at fc/4 is essentially flat (-0.05 dB), so post-
  // settling RMS should match the input within a percent or so.
  it('low-pass at high cutoff barely attenuates a low-frequency sine', () => {
    const sr = 44100;
    const N = 2048;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const out = applyFilter({ sampleRate: sr, channels: [sig] }, 'lowpass', 8000, 0.707);
    // Skip the first ~200 samples where the biquad is still settling from
    // its zero initial state.
    let ein = 0, eout = 0;
    for (let i = 200; i < N; i++) {
      ein  += sig[i]! * sig[i]!;
      eout += out.channels[0]![i]! * out.channels[0]![i]!;
    }
    const ratio = Math.sqrt(eout / ein);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it('low-pass at low cutoff strongly attenuates a high-frequency sine', () => {
    const sr = 44100;
    const N = 2048;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.sin(2 * Math.PI * 8000 * i / sr);
    const out = applyFilter({ sampleRate: sr, channels: [sig] }, 'lowpass', 500, 0.707);
    let ein = 0, eout = 0;
    for (let i = 200; i < N; i++) {
      ein  += sig[i]! * sig[i]!;
      eout += out.channels[0]![i]! * out.channels[0]![i]!;
    }
    expect(Math.sqrt(eout / ein)).toBeLessThan(0.05);
  });

  it('high-pass at high cutoff suppresses DC / very low content', () => {
    // Constant signal — pure DC. A high-pass should eat it.
    const sr = 44100;
    const N = 2048;
    const dc = new Float32Array(N).fill(0.5);
    const out = applyFilter({ sampleRate: sr, channels: [dc] }, 'highpass', 1000, 0.707);
    // After settling, output should be near zero.
    expect(Math.abs(out.channels[0]![N - 1]!)).toBeLessThan(0.01);
  });

  it('clamps absurd cutoff / Q values without producing NaN', () => {
    const w = mono(1, 0, -1, 0, 1, 0, -1, 0);
    const veryHigh = applyFilter(w, 'lowpass', 999_999, 0.5);
    const veryLow = applyFilter(w, 'lowpass', -100, 0.5);
    const huge = applyFilter(w, 'lowpass', 1000, 9999);
    for (const r of [veryHigh, veryLow, huge]) {
      for (const v of r.channels[0]!) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('applyCrossfade', () => {
  it('rewrites the loop tail so the wrap matches the pre-loop sample', () => {
    // Arrange a recognisable input: 12 frames where the "pre-loop" region
    // [0, 4) is the marker bytes 1..4, the loop is [4, 12) filled with
    // distinct values 10..17. With xfade length 4 covering the last 4
    // frames of the loop, those frames should fade from the original loop
    // tail (14, 15, 16, 17) toward the pre-loop tail (1, 2, 3, 4) so that
    // out[11] === pre-loop[3] === 4 — making the 11→4 wrap continuous.
    const ch = Float32Array.from([1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17]);
    const out = applyCrossfade(
      { sampleRate: 44100, channels: [ch] },
      4,    // length
      4,    // loopStart
      12,   // loopEnd
    ).channels[0]!;
    // Frames before the fade region are untouched.
    expect(Array.from(out.subarray(0, 8))).toEqual([1, 2, 3, 4, 10, 11, 12, 13]);
    // Linear ramp: t = i/3 across the 4-frame fade. At i=3 (frame 11):
    // t = 1, so out[11] = pre-loop[3] = 4 — the loop wrap is now continuous.
    expect(out[11]!).toBeCloseTo(4, 6);
    // First xfade frame (i=0, frame 8): t = 0 → original value 14.
    expect(out[8]!).toBeCloseTo(14, 6);
    // Mid-fade (i=1, frame 9, t=1/3): blend of original 15 and pre-loop[1]=2.
    expect(out[9]!).toBeCloseTo((1 - 1 / 3) * 15 + (1 / 3) * 2, 6);
  });

  it('clamps to the smaller of length / loopStart / loop length', () => {
    // Loop is too short for a 100-frame fade — should clamp to 4.
    const ch = Float32Array.from([1, 2, 3, 4, 10, 11, 12, 13]);
    const out = applyCrossfade(
      { sampleRate: 44100, channels: [ch] },
      100, // requested length way more than loop has
      4, 8,
    ).channels[0]!;
    // out[7] (last loop frame) should match pre-loop[3] = 4.
    expect(out[7]!).toBeCloseTo(4, 6);
    // No NaN, no out-of-bounds reads.
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('is a no-op when there is no pre-loop tail', () => {
    // loopStart === 0 → can't read any pre-loop content.
    const ch = Float32Array.from([10, 20, 30, 40]);
    const out = applyCrossfade(
      { sampleRate: 44100, channels: [ch] },
      2, 0, 4,
    );
    expect(Array.from(out.channels[0]!)).toEqual([10, 20, 30, 40]);
  });
});

describe('runChain', () => {
  it('runs effects in order', () => {
    const out = runChain(mono(0.25, -0.5, 0.5), [
      { kind: 'gain', params: { gain: 2 } },                            // ×2 → 0.5, -1, 1
      { kind: 'reverse', params: { startFrame: 0, endFrame: 3 } },      // → 1, -1, 0.5
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
      source: { kind: 'sampler', wav: stereo([0.5, 0.5], [-0.5, -0.5]), sourceName: 'demo' },
      chain: [{ kind: 'gain', params: { gain: 2 } }], // → 1, 1 / -1, -1
      pt: { monoMix: 'average', targetNote: null },                      // → 0, 0
      alt: null,
    };
    const out = runPipeline(wb);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it('with no effects, passes the source straight through to int8', () => {
    const wb: SampleWorkbench = {
      source: { kind: 'sampler', wav: mono(0, 1, -1), sourceName: 'demo' },
      chain: [],
      pt: { monoMix: 'average', targetNote: null },
      alt: null,
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
    if (wb.source.kind !== 'sampler') throw new Error('expected sampler source');
    expect(wb.source.wav.sampleRate).toBe(22050);
    expect(wb.source.wav.channels).toHaveLength(1);
    expect(wb.source.sourceName).toBe('beep');
    expect(wb.chain).toEqual([]);
    expect(wb.pt.monoMix).toBe('average');
    expect(wb.pt.targetNote).toBe(DEFAULT_TARGET_NOTE); // C-2 = 12
  });

  it("defaults the resampler to 'sinc' for fresh WAV imports (best quality)", () => {
    // WAV imports are typically 44.1 kHz material that gets downsampled ~5:1
    // to the C-2 rate; sinc avoids the audible aliasing plain linear produces.
    const wav = writeWav({
      sampleRate: 44100,
      channels: [new Float32Array([0, 0.5, -0.5])],
    }, { bitsPerSample: 16 });
    const wb = workbenchFromWav(wav, 'snare.wav');
    expect(wb.pt.resampleMode).toBe('sinc');
  });

  it("workbenchFromInt8 keeps the resampler at the back-compat default ('linear')", () => {
    // .mod-loaded slots wrap their existing int8 at the C-2 rate — the
    // resampler short-circuits anyway, and keeping the historical default
    // means existing projects' int8 stays bit-identical until the user
    // edits anything.
    const wb = workbenchFromInt8(new Int8Array([0, 64, -64, 0]), 'mod-slot');
    expect(wb.pt.resampleMode).toBe('linear');
  });
});

describe('SampleSource', () => {
  it('workbenchFromChiptune builds a chiptune-source workbench with no resampling', () => {
    const wb = workbenchFromChiptune(defaultChiptuneParams());
    expect(wb.source.kind).toBe('chiptune');
    expect(wb.chain).toEqual([]);
    // PT resampling is off — pitch comes from PT period applied to cycle length.
    expect(wb.pt.targetNote).toBeNull();
  });

  it('materializeSource returns the WAV for sampler and a synth cycle for chiptune', () => {
    const wav = writeWav(
      { sampleRate: 22050, channels: [new Float32Array([0, 0.5, -0.5])] },
      { bitsPerSample: 16 },
    );
    const sampler = workbenchFromWav(wav, 'beep.wav');
    expect(materializeSource(sampler.source).channels[0]!.length).toBe(3);

    const chip = workbenchFromChiptune({ ...defaultChiptuneParams(), cycleFrames: 32 });
    expect(materializeSource(chip.source).channels[0]!.length).toBe(32);
  });

  it('sourceWantsFullLoop is true for chiptune, false for sampler', () => {
    expect(sourceWantsFullLoop({ kind: 'chiptune', params: defaultChiptuneParams() })).toBe(true);
    expect(sourceWantsFullLoop({
      kind: 'sampler',
      wav: { sampleRate: 44100, channels: [new Float32Array(8)] },
      sourceName: 'demo',
    })).toBe(false);
  });

  it('sourceDisplayName falls back to "Chiptune" for the synth source', () => {
    expect(sourceDisplayName({ kind: 'chiptune', params: defaultChiptuneParams() }))
      .toBe('Chiptune');
    expect(sourceDisplayName({
      kind: 'sampler',
      wav: { sampleRate: 44100, channels: [new Float32Array(2)] },
      sourceName: 'beep',
    })).toBe('beep');
  });

  it('runPipeline on a chiptune workbench emits int8 of cycleFrames length', () => {
    const wb = workbenchFromChiptune({ ...defaultChiptuneParams(), cycleFrames: 32 });
    const data = runPipeline(wb);
    expect(data.length).toBe(32);
  });

  it('workbenchFromWav and workbenchFromChiptune both default `alt` to null', () => {
    const wav = writeWav(
      { sampleRate: 22050, channels: [new Float32Array([0, 0.5])] },
      { bitsPerSample: 16 },
    );
    expect(workbenchFromWav(wav, 'beep.wav').alt).toBeNull();
    expect(workbenchFromChiptune().alt).toBeNull();
  });

  it('workbenchToAlt copies the active source/chain/pt without the alt itself', () => {
    const wb = workbenchFromChiptune();
    const alt = workbenchToAlt(wb);
    expect(alt.source).toBe(wb.source);
    expect(alt.chain).toBe(wb.chain);
    expect(alt.pt).toBe(wb.pt);
    // No `alt` field on the alt — that's the recursion guard.
    expect((alt as unknown as { alt?: unknown }).alt).toBeUndefined();
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

describe('resampleFilteredLinear', () => {
  it('matches resampleLinear when fromRate === toRate (no-op short-circuit)', () => {
    const buf = Float32Array.from([0, 1, -1, 0.5]);
    expect(resampleFilteredLinear(buf, 44100, 44100)).toBe(buf);
  });

  it('matches plain linear when upsampling — no aliasing risk, no pre-filter', () => {
    const buf = Float32Array.from([0, 1, 0, -1, 0]);
    const linear = resampleLinear(buf, 22050, 44100);
    const filtered = resampleFilteredLinear(buf, 22050, 44100);
    expect(filtered.length).toBe(linear.length);
    for (let i = 0; i < filtered.length; i++) {
      expect(filtered[i]!).toBeCloseTo(linear[i]!, 6);
    }
  });

  it('downsample output length matches the linear resampler', () => {
    // The filter changes amplitudes but not the integer-frame target length —
    // both resamplers walk the same i*ratio grid.
    const buf = new Float32Array(256).fill(0.25);
    const linear = resampleLinear(buf, 44100, 8287);
    const filtered = resampleFilteredLinear(buf, 44100, 8287);
    expect(filtered.length).toBe(linear.length);
  });

  it('attenuates an above-Nyquist sine far more than plain linear', () => {
    // 6 kHz tone at 44.1 kHz, downsampled to 8.287 kHz (target Nyquist ~4.14 kHz).
    // With plain linear, the 6 kHz aliases to about |8287 − 6000| = 2287 Hz at
    // similar amplitude. With the LPF prefilter, that 6 kHz content is gone
    // before the resampler hops over it, so the post-resample RMS drops sharply.
    const fromRate = 44100;
    const toRate = 8287;
    const N = 4096;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 6000 * i) / fromRate);
    const linear = resampleLinear(sig, fromRate, toRate);
    const filtered = resampleFilteredLinear(sig, fromRate, toRate);
    function rms(b: Float32Array): number {
      let s = 0;
      // Skip the head where the biquad is still settling.
      for (let i = 100; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / Math.max(1, b.length - 100));
    }
    expect(rms(filtered)).toBeLessThan(rms(linear) * 0.25);
  });
});

describe('resampleSinc', () => {
  it('returns the same reference when fromRate === toRate', () => {
    const buf = Float32Array.from([0, 1, -1, 0.5]);
    expect(resampleSinc(buf, 44100, 44100)).toBe(buf);
  });

  it('preserves an empty input as an empty output', () => {
    expect(resampleSinc(new Float32Array(0), 44100, 8287).length).toBe(0);
  });

  it('produces the expected output length for a downsample', () => {
    const buf = new Float32Array(256).fill(1);
    const out = resampleSinc(buf, 44100, 8287);
    // ~256 frames * 8287/44100 ≈ 48 frames, matching the linear resampler.
    expect(out.length).toBeGreaterThan(40);
    expect(out.length).toBeLessThan(60);
  });

  it('preserves DC at unity gain across downsamples (constant-input test)', () => {
    const buf = new Float32Array(256).fill(0.5);
    const out = resampleSinc(buf, 44100, 8287);
    // Mid-buffer samples are far from the truncated kernel boundary —
    // unity-DC normalisation should hold to f32 precision.
    expect(out[10]!).toBeCloseTo(0.5, 4);
    expect(out[Math.floor(out.length / 2)]!).toBeCloseTo(0.5, 4);
  });

  it('attenuates an above-Nyquist sine far more than plain linear', () => {
    const fromRate = 44100;
    const toRate = 8287;
    const N = 4096;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * 6000 * i) / fromRate);
    const linear = resampleLinear(sig, fromRate, toRate);
    const sinc = resampleSinc(sig, fromRate, toRate);
    function rms(b: Float32Array): number {
      let s = 0;
      for (let i = 100; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / Math.max(1, b.length - 100));
    }
    expect(rms(sinc)).toBeLessThan(rms(linear) * 0.25);
  });
});

describe('resample-mode registration', () => {
  it("RESAMPLE_MODES lists 'linear', 'filteredLinear' and 'sinc'", () => {
    expect(RESAMPLE_MODES).toEqual(['linear', 'filteredLinear', 'sinc']);
  });

  it('every mode has a human-readable label', () => {
    for (const m of RESAMPLE_MODES) {
      expect(typeof RESAMPLE_LABELS[m]).toBe('string');
      expect(RESAMPLE_LABELS[m].length).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_RESAMPLE_MODE is 'linear' (back-compat for old projects)", () => {
    expect(DEFAULT_RESAMPLE_MODE).toBe('linear');
  });
});

describe('transformToPt resampleMode dispatch', () => {
  it("'linear' produces the same int8 as the historical (no-mode) call", () => {
    const audio = { sampleRate: 44100, channels: [new Float32Array(256).fill(1)] };
    const a = transformToPt(audio, { monoMix: 'average', targetNote: 12, resampleMode: 'linear' });
    const b = transformToPt(audio, { monoMix: 'average', targetNote: 12 }); // no mode → fallback
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("'sinc' produces a different waveform from 'linear' on a downsample", () => {
    // A varying signal so the two algorithms actually diverge — a flat line
    // would round to the same int8 under any band-limited resampler.
    const N = 256;
    const ch = new Float32Array(N);
    for (let i = 0; i < N; i++) ch[i] = Math.sin((2 * Math.PI * 3000 * i) / 44100);
    const audio = { sampleRate: 44100, channels: [ch] };
    const linear = transformToPt(audio, { monoMix: 'average', targetNote: 12, resampleMode: 'linear' });
    const sinc = transformToPt(audio, { monoMix: 'average', targetNote: 12, resampleMode: 'sinc' });
    expect(linear.length).toBe(sinc.length);
    let diff = 0;
    for (let i = 0; i < linear.length; i++) diff += Math.abs(linear[i]! - sinc[i]!);
    expect(diff).toBeGreaterThan(0);
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
    expect(applyEffect(mono(1, 2, 3), { kind: 'reverse', params: { startFrame: 0, endFrame: 3 } })
      .channels[0]).toEqual(Float32Array.from([3, 2, 1]));
    expect(applyEffect(mono(0, 1, 2, 3, 4), { kind: 'cut', params: { startFrame: 1, endFrame: 4 } })
      .channels[0]).toEqual(Float32Array.from([0, 4]));
  });

  it("dispatches 'shaper' through applyShaperEffect (drive saturates)", () => {
    // hardClip at amount=1 has drive=9 — 0.5×9=4.5 → clamp to ±1.
    const out = applyEffect(mono(0.5, -0.5), {
      kind: 'shaper', params: { mode: 'hardClip', amount: 1 },
    });
    expect(Array.from(out.channels[0]!)).toEqual([1, -1]);
  });
});

describe('applyShaperEffect', () => {
  it("'none' is a fast-path passthrough (returns the same WavData reference)", () => {
    const w = mono(0.5, -0.25, 0);
    expect(applyShaperEffect(w, 'none', 1)).toBe(w);
  });

  it('amount=0 short-circuits regardless of mode (same reference)', () => {
    const w = mono(0.5, -0.25, 0);
    expect(applyShaperEffect(w, 'hardClip', 0)).toBe(w);
    expect(applyShaperEffect(w, 'wavefold', 0)).toBe(w);
    expect(applyShaperEffect(w, 'bitcrush', 0)).toBe(w);
  });

  it('hardClip at amount=1 clamps small inputs to ±1 across the whole sample', () => {
    const out = applyShaperEffect(mono(0.5, -0.5, 0.5), 'hardClip', 1);
    expect(Array.from(out.channels[0]!)).toEqual([1, -1, 1]);
  });

  it('shapes each channel independently on stereo input', () => {
    const stereoIn = stereo([0.5, -0.5], [0.25, -0.25]);
    const out = applyShaperEffect(stereoIn, 'hardClip', 1);
    // Both channels driven 9× then clamped — both saturate to ±1.
    expect(Array.from(out.channels[0]!)).toEqual([1, -1]);
    expect(Array.from(out.channels[1]!)).toEqual([1, -1]);
  });

  it('does not mutate the input WavData', () => {
    const ch = Float32Array.from([0.5, -0.5]);
    const w = { sampleRate: sr, channels: [ch] };
    applyShaperEffect(w, 'hardClip', 1);
    expect(Array.from(ch)).toEqual([0.5, -0.5]);
  });

  it('end-to-end: shaper node in a chain feeds the rest of the pipeline', () => {
    const wb: SampleWorkbench = {
      source: { kind: 'sampler', wav: mono(0.5, -0.5), sourceName: 'demo' },
      chain: [{ kind: 'shaper', params: { mode: 'hardClip', amount: 1 } }],
      pt: { monoMix: 'average', targetNote: null },
      alt: null,
    };
    // 0.5 → +1 → int8 127; -0.5 → -1 → int8 -127.
    expect(Array.from(runPipeline(wb))).toEqual([127, -127]);
  });
});

describe("'shaper' effect kind registration", () => {
  it("EFFECT_KINDS includes 'shaper'", () => {
    expect(EFFECT_KINDS).toContain('shaper');
  });

  it("EFFECT_LABELS has a human-readable 'Shaper' label", () => {
    expect(EFFECT_LABELS.shaper).toBe('Shaper');
  });

  it("defaultEffect('shaper') produces softClip at half drive", () => {
    const e = defaultEffect('shaper', mono(0));
    expect(e.kind).toBe('shaper');
    if (e.kind === 'shaper') {
      expect(e.params.mode).toBe('softClip');
      expect(e.params.amount).toBe(0.5);
    }
  });
});

describe('runChain composes crop + cut', () => {
  it('crop then cut leaves a hole in the kept range', () => {
    const out = runChain(mono(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), [
      { kind: 'crop', params: { startFrame: 2, endFrame: 8 } }, // → 2,3,4,5,6,7
      { kind: 'cut',  params: { startFrame: 1, endFrame: 3 } }, //   keep [2] then [5,6,7] → 2,5,6,7
    ]);
    expect(Array.from(out.channels[0]!)).toEqual([2, 5, 6, 7]);
  });
});
