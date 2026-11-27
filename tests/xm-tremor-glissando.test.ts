import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmNote, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

const SR = 44100;
/** BPM 125 → exactly 882 frames per tick at 44.1 kHz. */
const TICK = 882;
const SAMPLE_LEN = 32;

/** One looped 32-frame triangle: C-4 plays at 8363/32 ≈ 261 Hz, several
 *  cycles per tick, so per-tick pitch is measurable. */
function song(): XmSong {
  const data = new Int8Array(SAMPLE_LEN);
  for (let i = 0; i < SAMPLE_LEN; i++) {
    const p = i / SAMPLE_LEN;
    data[i] = Math.round(100 * (p < 0.5 ? 4 * p - 1 : 3 - 4 * p));
  }
  return setXmInstrument(emptyXmSong(), 0, {
    ...emptyXmInstrument(),
    name: "tri",
    samples: [
      {
        name: "tri",
        data,
        bits: 8,
        loopStart: 0,
        loopLength: SAMPLE_LEN,
        loopType: "forward",
        volume: 64,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
  });
}

const put = (s: XmSong, row: number, patch: Partial<XmNote>) =>
  setXmCell(s, 0, row, 0, patch);

function render(s: XmSong, ticks: number): Float32Array {
  const r = new XmReplayer(s, { sampleRate: SR });
  const l = new Float32Array(TICK * ticks);
  r.process(l, new Float32Array(l.length), l.length);
  return l;
}

/** Pitch during tick `t` in semitones above C-4, from the mean spacing of
 *  rising zero crossings. */
function semitones(buf: Float32Array, t: number): number {
  let first = -1;
  let last = -1;
  let cycles = 0;
  for (let i = t * TICK + 1; i < (t + 1) * TICK; i++) {
    const a = buf[i - 1]!;
    const b = buf[i]!;
    if (a <= 0 && b > 0) {
      const x = i - b / (b - a);
      if (first < 0) first = x;
      else cycles++;
      last = x;
    }
  }
  const hz = (SR * cycles) / (last - first);
  return 12 * Math.log2(hz / (8363 / SAMPLE_LEN));
}

function peak(buf: Float32Array, t: number): number {
  let p = 0;
  // Skip the first quarter of the tick: the anti-click ramp.
  for (let i = t * TICK + Math.floor(TICK / 4); i < (t + 1) * TICK; i++) {
    p = Math.max(p, Math.abs(buf[i]!));
  }
  return p;
}

describe("E3x glissando", () => {
  /** C-4, then a 302 slide towards G-4: 1/8 semitone per tick. */
  function slide(glissando: boolean): XmSong {
    let s = song();
    s = put(s, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: glissando ? 0x31 : 0x30,
    });
    s = put(s, 1, { note: 56, effect: 0x03, effectParam: 0x02 });
    return s;
  }

  it("slides smoothly when off", () => {
    const buf = render(slide(false), 12);
    expect(semitones(buf, 6 + 3)).toBeCloseTo(0.375, 1);
    expect(semitones(buf, 6 + 5)).toBeCloseTo(0.625, 1);
  });

  it("steps in semitones, and an exact halfway point stays on the lower note", () => {
    const buf = render(slide(true), 12);
    // Row 1 ticks 1..5 put the real pitch at 0.125 .. 0.625 semitones.
    expect(semitones(buf, 6 + 3)).toBeCloseTo(0, 1);
    expect(semitones(buf, 6 + 4)).toBeCloseTo(0, 1); // exactly 0.5 → down
    expect(semitones(buf, 6 + 5)).toBeCloseTo(1, 1);
  });

  it("keeps the rounded pitch after the portamento row ends", () => {
    // Real pitch is left at 0.625; FT2 holds the stepped note until
    // something else writes the pitch.
    const buf = render(slide(true), 24);
    expect(semitones(buf, 12 + 3)).toBeCloseTo(1, 1);
    expect(semitones(buf, 18 + 3)).toBeCloseTo(1, 1);
  });

  it("a pitch slide after the portamento drops back to the real pitch", () => {
    let s = slide(true);
    s = put(s, 2, { effect: 0x0e, effectParam: 0x11 }); // E11: +1/16
    const buf = render(s, 18);
    expect(semitones(buf, 12 + 3)).toBeCloseTo(0.6875, 1);
  });

  it("steps relative to the sample's finetune", () => {
    let s = slide(true);
    const inst = s.instruments[0]!;
    s = setXmInstrument(s, 0, {
      ...inst,
      samples: [{ ...inst.samples[0]!, finetune: 32 }], // +1/4 semitone
    });
    const buf = render(s, 12);
    expect(semitones(buf, 6 + 5)).toBeCloseTo(1.25, 1);
  });
});

describe("Txy tremor", () => {
  it("gates the note x+1 ticks on, y+1 ticks off, from tick 1", () => {
    let s = song();
    s = put(s, 0, { note: 49, instrument: 1, effect: 0x1d, effectParam: 0x10 });
    const buf = render(s, 6);
    const on = [0, 1, 2, 4, 5].map((t) => peak(buf, t));
    for (const p of on) expect(p).toBeGreaterThan(0.1);
    expect(peak(buf, 3)).toBe(0);
  });

  it("T00 reuses the last parameter and the phase runs across rows", () => {
    let s = song();
    s = put(s, 0, { note: 49, instrument: 1, effect: 0x1d, effectParam: 0x21 });
    s = put(s, 1, { effect: 0x1d, effectParam: 0x00 });
    const buf = render(s, 12);
    // Row 0: ticks 1-3 on, 4-5 off. Row 1 tick 0 runs no effect (still
    // off), then ticks 1-3 on, 4-5 off again.
    const silent = [4, 5, 6, 10, 11];
    for (let t = 1; t < 12; t++) {
      if (silent.includes(t)) expect(peak(buf, t)).toBe(0);
      else expect(peak(buf, t)).toBeGreaterThan(0.1);
    }
  });

  it("stays silent after a row that ends in the off half, until the volume is set", () => {
    let s = song();
    s = put(s, 0, { note: 49, instrument: 1 });
    s = put(s, 1, { effect: 0x1d, effectParam: 0x05 }); // 1 on, 6 off
    s = put(s, 3, { effect: 0x0c, effectParam: 0x20 });
    const buf = render(s, 24);
    expect(peak(buf, 6 + 1)).toBeGreaterThan(0.1);
    expect(peak(buf, 6 + 3)).toBe(0);
    expect(peak(buf, 12 + 3)).toBe(0); // row 2: no effect, still muted
    expect(peak(buf, 18 + 3)).toBeGreaterThan(0.05); // row 3: C20
  });

  it("a new note restarts the phase", () => {
    let s = song();
    s = put(s, 0, { note: 49, instrument: 1, effect: 0x1d, effectParam: 0x13 });
    s = put(s, 1, { note: 49, instrument: 1, effect: 0x1d, effectParam: 0x13 });
    const buf = render(s, 12);
    // Each row: ticks 1-2 on, 3-5 off — identical, not a continued cycle.
    for (const base of [0, 6]) {
      expect(peak(buf, base + 2)).toBeGreaterThan(0.1);
      expect(peak(buf, base + 4)).toBe(0);
    }
  });
});
