import { describe, expect, it } from "vitest";

import {
  XM_BASE_HZ,
  hzForNote,
  hzForPeriod,
  periodForNote,
  periodForNoteAmiga,
  periodForNoteLinear,
} from "~/core/audio/xmFreqTable";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

describe("XM period tables (FT2)", () => {
  it("linear: 64 units per semitone, C-4 = 4608", () => {
    expect(periodForNoteLinear(49, 0)).toBe(4608);
    expect(periodForNoteLinear(50, 0)).toBe(4608 - 64);
    expect(periodForNoteLinear(1, 0)).toBe(7680);
  });

  it("Amiga: spot values from FT2's table", () => {
    // C-4 is four times the ProTracker period 428.
    expect(periodForNoteAmiga(49, 0)).toBe(1712);
    expect(periodForNoteAmiga(1, 0)).toBe(27392); // C-0
    expect(periodForNoteAmiga(1, -128)).toBe(29024); // first table entry
    expect(periodForNoteAmiga(61, 0)).toBe(856); // C-5
    // Not equal temperament: FT2 interpolates between PT periods.
    expect(periodForNoteAmiga(2, 0)).toBe(25856); // C#0
  });

  it("finetune resolves in 1/16-semitone steps, flooring like FT2's >> 3", () => {
    for (const linear of [true, false]) {
      const at = (ft: number) => periodForNote(49, ft, linear);
      expect(at(7)).toBe(at(0));
      expect(at(8)).toBeLessThan(at(0));
      expect(at(15)).toBe(at(8));
      // Arithmetic shift: -1 falls into the step below 0, not onto it.
      expect(at(-1)).toBe(at(-8));
      expect(at(-1)).toBeGreaterThan(at(0));
    }
    expect(periodForNoteLinear(49, 8)).toBe(4608 - 4);
  });

  it("clamps the lookup to the table", () => {
    expect(periodForNoteLinear(200, 0)).toBe(4);
    expect(periodForNoteAmiga(-5, 0)).toBe(29024);
  });

  it("C-4 at finetune 0 plays at 8363 Hz in both modes", () => {
    expect(hzForNote(49, 0, true)).toBeCloseTo(XM_BASE_HZ, 6);
    expect(hzForNote(49, 0, false)).toBeCloseTo(XM_BASE_HZ, 6);
  });

  it("an octave doubles the rate", () => {
    expect(hzForNote(61, 0, true) / hzForNote(49, 0, true)).toBeCloseTo(2, 9);
    expect(hzForNote(61, 0, false) / hzForNote(49, 0, false)).toBeCloseTo(2, 9);
  });

  it("Amiga mode is a slightly different tuning from linear", () => {
    // FT2's periods drift from equal temperament: about 4 cents through
    // octave 6, about 10 in octave 7 where the integer periods are small.
    const worst = (from: number, to: number) => {
      let w = 0;
      for (let note = from; note <= to; note++) {
        const cents =
          1200 *
          Math.log2(hzForNote(note, 0, false) / hzForNote(note, 0, true));
        w = Math.max(w, Math.abs(cents));
      }
      return w;
    };
    expect(worst(1, 84)).toBeGreaterThan(3);
    expect(worst(1, 84)).toBeLessThan(5);
    expect(worst(85, 96)).toBeLessThan(11);
  });

  it("hzForPeriod inverts both tables' units", () => {
    expect(hzForPeriod(4608 - 768, true)).toBeCloseTo(2 * XM_BASE_HZ, 6);
    expect(hzForPeriod(856, false)).toBeCloseTo(2 * XM_BASE_HZ, 6);
  });
});

describe("Amiga-mode effects use FT2's period units", () => {
  const SR = 44100;
  const TICK = 882;
  const LEN = 32;

  function song(): XmSong {
    const data = new Int8Array(LEN);
    for (let i = 0; i < LEN; i++) {
      const p = i / LEN;
      data[i] = Math.round(100 * (p < 0.5 ? 4 * p - 1 : 3 - 4 * p));
    }
    const s = setXmInstrument(emptyXmSong(), 0, {
      ...emptyXmInstrument(),
      samples: [
        {
          name: "tri",
          data,
          bits: 8,
          loopStart: 0,
          loopLength: LEN,
          loopType: "forward",
          volume: 64,
          finetune: 0,
          panning: 128,
          relativeNote: 0,
        },
      ],
    });
    return { ...s, flags: { ...s.flags, linearFreq: false } };
  }

  /** Playback rate of the sample during tick `t`, from zero crossings. */
  function rateAt(s: XmSong, t: number): number {
    const r = new XmReplayer(s, { sampleRate: SR });
    const buf = new Float32Array(TICK * (t + 1));
    r.process(buf, new Float32Array(buf.length), buf.length);
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
    return ((SR * cycles) / (last - first)) * LEN;
  }

  it("1xx slides the period by 4 × param per tick from 1712", () => {
    const s = setXmCell(song(), 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x01,
      effectParam: 0x10,
    });
    // Ticks 1..5 each subtract 64: 1712 → 1392 by the last tick.
    expect(rateAt(s, 5) / XM_BASE_HZ).toBeCloseTo(1712 / 1392, 2);
  });

  it("arpeggio offsets by whole semitones", () => {
    const s = setXmCell(song(), 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x00,
      effectParam: 0x7c,
    });
    expect(rateAt(s, 1) / XM_BASE_HZ).toBeCloseTo(Math.pow(2, 7 / 12), 2);
    expect(rateAt(s, 2) / XM_BASE_HZ).toBeCloseTo(2, 2);
  });
});
