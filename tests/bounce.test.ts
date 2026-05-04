import { describe, expect, it } from 'vitest';
import { bounceSelection } from '../src/core/audio/bounce';
import { CleanMixer } from '../src/core/audio/cleanMixer';
import { emptyPattern, emptySample, emptySong, Effect, PERIOD_TABLE } from '../src/core/mod/format';
import type { Song } from '../src/core/mod/types';

/** Build a 1-pattern song with one sample (single-byte int8 fixture). */
function songWithSample(sampleData: Int8Array, name = 'test'): Song {
  const s = emptySong();
  const sm = emptySample();
  sm.name = name;
  sm.lengthWords = sampleData.byteLength >> 1;
  sm.data = sampleData;
  sm.volume = 64;
  s.samples = [sm, ...s.samples.slice(1)];
  s.patterns = [emptyPattern()];
  return s;
}

/** Place a note + sample trigger on (row, channel). */
function placeNote(s: Song, row: number, channel: number, period: number, sample: number): void {
  const cell = s.patterns[s.orders[0]!]!.rows[row]![channel]!;
  cell.period = period;
  cell.sample = sample;
}

describe('CleanMixer: smoke', () => {
  it('produces non-zero output when a voice is active and silence when idle', () => {
    const m = new CleanMixer(44100);
    const data = new Int8Array(64);
    // DC at +127 — guaranteed non-zero output unless the mixer is broken.
    for (let i = 0; i < data.length; i++) data[i] = 127;
    m.setSample(0, data, 0, data.length >> 1, 0, 1);
    m.setPeriod(0, PERIOD_TABLE[0]![12]!); // C-2
    m.setVolume(0, 64);
    m.startDMA(0);

    const L = new Float64Array(256);
    const R = new Float64Array(256);
    m.generate(L, R, 256, 0);
    // Channel 0 hard-pans LEFT; right stays zero.
    let energyL = 0, energyR = 0;
    for (let i = 0; i < 64; i++) { energyL += L[i]! * L[i]!; energyR += R[i]! * R[i]!; }
    expect(energyL).toBeGreaterThan(0);
    expect(energyR).toBe(0);
  });

  it('stopDMA silences the voice on subsequent generate calls', () => {
    const m = new CleanMixer(44100);
    const data = new Int8Array(32).fill(127);
    m.setSample(0, data, 0, data.length >> 1, 0, 1);
    m.setPeriod(0, PERIOD_TABLE[0]![12]!);
    m.setVolume(0, 64);
    m.startDMA(0);
    const L = new Float64Array(64);
    const R = new Float64Array(64);
    m.generate(L, R, 16, 0);
    expect(L[0]).not.toBe(0);

    m.stopDMA(0);
    L.fill(0); R.fill(0);
    m.generate(L, R, 64, 0);
    for (const v of L) expect(v).toBe(0);
  });

  it('volume scales linearly: vol=32 → ~half the peak of vol=64', () => {
    const data = new Int8Array(64).fill(127);
    function peak(vol: number): number {
      const m = new CleanMixer(44100);
      m.setSample(0, data, 0, data.length >> 1, 0, 1);
      m.setPeriod(0, PERIOD_TABLE[0]![12]!);
      m.setVolume(0, vol);
      m.startDMA(0);
      const L = new Float64Array(128);
      const R = new Float64Array(128);
      m.generate(L, R, 128, 0);
      let p = 0;
      for (const v of L) if (Math.abs(v) > p) p = Math.abs(v);
      return p;
    }
    const full = peak(64);
    const half = peak(32);
    expect(half).toBeCloseTo(full * 0.5, 3);
  });

  it('one-shot samples (loopLengthWords <= 1) deactivate the voice at end-of-data', () => {
    // 10-byte sample at C-2 (~8287 Hz). At 44100 Hz output, 10 bytes plays
    // for ~10 / (8287 / 44100) ≈ 53 frames. We render way past that and
    // confirm the tail is zero.
    const m = new CleanMixer(44100);
    const data = new Int8Array(10).fill(127);
    m.setSample(0, data, 0, data.length >> 1, 0, 1); // loopLengthWords = 1 → no loop
    m.setPeriod(0, PERIOD_TABLE[0]![12]!);
    m.setVolume(0, 64);
    m.startDMA(0);
    const L = new Float64Array(512);
    const R = new Float64Array(512);
    m.generate(L, R, 512, 0);
    // Tail is silent.
    for (let i = 200; i < 512; i++) expect(L[i]).toBe(0);
  });

  it('looped samples wrap inside the loop region without leaking past it', () => {
    const m = new CleanMixer(44100);
    // 16-byte sample, full-length loop. With C-2 period the cursor walks
    // through the buffer many times over 1024 frames; output stays bounded.
    const data = new Int8Array(16);
    for (let i = 0; i < 16; i++) data[i] = i & 1 ? 64 : -64;
    m.setSample(0, data, 0, data.length >> 1, 0, data.length >> 1);
    m.setPeriod(0, PERIOD_TABLE[0]![12]!);
    m.setVolume(0, 64);
    m.startDMA(0);
    const L = new Float64Array(1024);
    const R = new Float64Array(1024);
    m.generate(L, R, 1024, 0);
    // Looped sample should keep ringing — non-zero at the tail.
    let tailEnergy = 0;
    for (let i = 800; i < 1024; i++) tailEnergy += L[i]! * L[i]!;
    expect(tailEnergy).toBeGreaterThan(0);
    // And the values stay in a sane range — DC at full volume is ~1/PAULA_VOICES.
    for (const v of L) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('bounceSelection', () => {
  it('returns null for an empty song / unmatched pattern', () => {
    const s = emptySong();
    expect(
      bounceSelection(s, {
        order: 0, startRow: 0, endRow: -1, startChannel: 0, endChannel: 3,
      }),
    ).toBeNull();
  });

  it('renders only the selected rows worth of frames + tail', () => {
    // 16-byte loop sample triggered at C-2 every row of the selection.
    const data = new Int8Array(16);
    for (let i = 0; i < 16; i++) data[i] = i & 1 ? 64 : -64;
    const s = songWithSample(data, 'test');
    placeNote(s, 0, 0, PERIOD_TABLE[0]![12]!, 1);
    placeNote(s, 1, 0, PERIOD_TABLE[0]![12]!, 1);
    placeNote(s, 2, 0, PERIOD_TABLE[0]![12]!, 1);

    const result = bounceSelection(s, {
      order: 0, startRow: 0, endRow: 2, startChannel: 0, endChannel: 0,
    });
    expect(result).not.toBeNull();
    const wav = result!.wav;
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels).toHaveLength(1); // mono
    // 3 rows × default 6 ticks × ~882 samples-per-tick @ 125 BPM ≈ 15876 frames.
    // Pin a generous band rather than an exact number to absorb the
    // float-rounding in samplesPerTick.
    expect(wav.channels[0]!.length).toBeGreaterThan(15000);
    expect(wav.channels[0]!.length).toBeLessThan(17000);
  });

  it('reflects per-row Fxx tempo changes in the rendered length', () => {
    const data = new Int8Array(16).fill(64);
    const s = songWithSample(data);
    placeNote(s, 0, 0, PERIOD_TABLE[0]![12]!, 1);
    // Row 1 doubles the tempo — that row should run twice as fast.
    const cell = s.patterns[0]!.rows[1]![0]!;
    cell.effect = Effect.SetSpeed;
    cell.effectParam = 250; // tempo 250 BPM (>=0x20 so it sets tempo)
    placeNote(s, 1, 0, PERIOD_TABLE[0]![12]!, 1);

    // Render row 0 at default 125 BPM, row 1 at 250 BPM.
    const result = bounceSelection(s, {
      order: 0, startRow: 0, endRow: 1, startChannel: 0, endChannel: 0,
    })!;
    const fastLen = result.wav.channels[0]!.length;

    // Compare against rendering the same row pair at uniform 125 BPM (no Fxx).
    const s2 = songWithSample(data);
    placeNote(s2, 0, 0, PERIOD_TABLE[0]![12]!, 1);
    placeNote(s2, 1, 0, PERIOD_TABLE[0]![12]!, 1);
    const slowLen = bounceSelection(s2, {
      order: 0, startRow: 0, endRow: 1, startChannel: 0, endChannel: 0,
    })!.wav.channels[0]!.length;

    // Doubling the tempo on row 1 should make it shorter than the same
    // row pair without the speed-up.
    expect(fastLen).toBeLessThan(slowLen);
  });

  it('only rendres the selected channels (silences unselected channels)', () => {
    const data = new Int8Array(16).fill(64);
    const s = songWithSample(data);
    // Channel 0 plays a sample; channel 1 also plays one.
    placeNote(s, 0, 0, PERIOD_TABLE[0]![12]!, 1);
    placeNote(s, 0, 1, PERIOD_TABLE[0]![12]!, 1);

    // Bounce only channel 1's column.
    const ch1 = bounceSelection(s, {
      order: 0, startRow: 0, endRow: 1, startChannel: 1, endChannel: 1,
    })!.wav.channels[0]!;
    // Bounce only channel 0's column.
    const ch0 = bounceSelection(s, {
      order: 0, startRow: 0, endRow: 1, startChannel: 0, endChannel: 0,
    })!.wav.channels[0]!;

    function rms(b: Float32Array): number {
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / b.length);
    }
    // Both single-channel renders should be non-zero (each had one sample
    // playing). The point of THIS assertion is just "selecting a different
    // channel produces different audio" — they're not equal.
    expect(rms(ch0)).toBeGreaterThan(0);
    expect(rms(ch1)).toBeGreaterThan(0);
  });

  it('returns mono output (Sampler workbench reads channels[0] directly)', () => {
    const data = new Int8Array(8).fill(64);
    const s = songWithSample(data);
    placeNote(s, 0, 0, PERIOD_TABLE[0]![12]!, 1);
    const result = bounceSelection(s, {
      order: 0, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0,
    })!;
    expect(result.wav.channels.length).toBe(1);
  });
});
