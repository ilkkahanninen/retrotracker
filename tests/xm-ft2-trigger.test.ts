import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmNote, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

/**
 * What a row's note, instrument number and effect each restart — ft2-clone
 * `getNewNote`, `triggerNote`, `triggerInstrument`, `resetVolumes`. Values
 * are read back from rendered audio per tick.
 */

const SR = 44100;
/** BPM 125 → exactly 882 frames per tick; default speed 6 ticks per row. */
const TICK = 882;
const LEN = 32;
const E = 0x0e;

function instrument(volume: number, patch: Partial<XmInstrument> = {}) {
  const data = new Int8Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const p = i / LEN;
    data[i] = Math.round(100 * (p < 0.5 ? 4 * p - 1 : 3 - 4 * p));
  }
  const inst: XmInstrument = {
    ...emptyXmInstrument(),
    ...patch,
    samples: [
      {
        name: "tri",
        data,
        bits: 8,
        loopStart: 0,
        loopLength: LEN,
        loopType: "forward",
        volume,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
  };
  return inst;
}

type Rows = Array<Partial<XmNote>>;
const NOTE: Partial<XmNote> = { note: 49, instrument: 1 };

function render(rows: Rows, instruments = [instrument(64)]): Float32Array {
  let s: XmSong = emptyXmSong();
  instruments.forEach((inst, i) => {
    s = setXmInstrument(s, i, inst);
  });
  rows.forEach((cell, r) => {
    s = setXmCell(s, 0, r, 0, cell);
  });
  const r = new XmReplayer(s, { sampleRate: SR });
  const buf = new Float32Array(TICK * 6 * rows.length);
  r.process(buf, new Float32Array(buf.length), buf.length);
  return buf;
}

function pitch(buf: Float32Array, row: number, t: number): number {
  const start = (row * 6 + t) * TICK;
  let first = -1;
  let last = -1;
  let cycles = 0;
  for (let i = start + 1; i < start + TICK; i++) {
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
  return Number((12 * Math.log2(hz / (8363 / LEN))).toFixed(1)) + 0;
}

const FULL = (() => {
  const buf = render([NOTE]);
  let p = 0;
  for (let i = TICK; i < 5 * TICK; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
})();

/** Output level (0..64) on tick `t` of `row`, read after the click ramp. */
function level(buf: Float32Array, row: number, t: number): number {
  const start = (row * 6 + t) * TICK;
  let p = 0;
  for (let i = start + 300; i < start + TICK; i++) {
    p = Math.max(p, Math.abs(buf[i]!));
  }
  return Math.round((p / FULL) * 64);
}

const pitches = (buf: Float32Array, row: number) =>
  [0, 1, 2, 3, 4, 5].map((t) => pitch(buf, row, t));

describe("0xy arpeggio", () => {
  it("plays base, +y, +x at speed 6 — FT2's tick counter runs down", () => {
    const buf = render([NOTE, { effect: 0x00, effectParam: 0x47 }]);
    expect(pitches(buf, 1)).toEqual([0, 7, 4, 0, 7, 4]);
  });

  it("returns to the note on the row after", () => {
    const buf = render([NOTE, { effect: 0x00, effectParam: 0x47 }, {}]);
    expect(pitch(buf, 1, 5)).toBe(4);
    expect(pitch(buf, 2, 0)).toBe(0);
  });

  it("snaps a slid pitch to the nearest semitone while arpeggiating", () => {
    // 1 02 for 5 ticks raises the pitch 40 units = 0.625 semitone; the
    // arpeggio then works from the nearest note (+1), not from the
    // in-between pitch.
    const buf = render([
      NOTE,
      { effect: 0x01, effectParam: 0x02 },
      { effect: 0x00, effectParam: 0x30 },
    ]);
    expect(pitch(buf, 1, 5)).toBe(0.6);
    expect(pitch(buf, 2, 2)).toBe(1 + 3); // tick 2 = +x
    expect(pitch(buf, 2, 3)).toBe(0.6); // base step: back on the real pitch
  });
});

describe("what a row restarts", () => {
  /** Volume envelope held at full, so key-off fades instead of cutting. */
  const fading = (volume = 64) =>
    instrument(volume, {
      fadeout: 4096, // gone in 8 ticks
      volumeEnvelope: {
        enabled: true,
        sustainEnabled: false,
        loopEnabled: false,
        sustainPoint: 0,
        loopStart: 0,
        loopEnd: 0,
        points: [
          { tick: 0, value: 64 },
          { tick: 1, value: 64 },
        ],
      },
    });

  it("a note without an instrument number does not undo a key-off", () => {
    const rows: Rows = [NOTE, { note: 97 }, {}, { note: 49 }];
    const buf = render(rows, [fading()]);
    expect(level(buf, 0, 3)).toBe(64);
    expect(level(buf, 2, 5)).toBe(0); // faded out
    expect(level(buf, 3, 3)).toBe(0); // new note, still released
  });

  it("a note with an instrument number does", () => {
    const buf = render([NOTE, { note: 97 }, {}, NOTE], [fading()]);
    expect(level(buf, 3, 3)).toBe(64);
  });

  it("an instrument number alone restores the volume and restarts the instrument, not the sample", () => {
    const buf = render([NOTE, { note: 97 }, {}, { instrument: 1 }], [fading()]);
    expect(level(buf, 2, 5)).toBe(0);
    expect(level(buf, 3, 3)).toBe(64);
  });

  it("restores the playing sample's defaults, whichever instrument the row names", () => {
    const buf = render(
      [NOTE, { effect: 0x0c, effectParam: 0x10 }, { instrument: 2 }],
      [instrument(48), instrument(20)],
    );
    expect(level(buf, 1, 3)).toBe(16);
    expect(level(buf, 2, 3)).toBe(48);
  });

  it("an instrument number on a portamento row resets the volume without restarting the note", () => {
    const buf = render([
      NOTE,
      { effect: 0x0c, effectParam: 0x10 },
      { note: 61, instrument: 1, effect: 0x03, effectParam: 0x10 },
    ]);
    expect(level(buf, 2, 3)).toBe(64);
    // Still sliding from C-4 towards C-5: one tick in, 16 * 4 units = +1.
    expect(pitch(buf, 2, 1)).toBe(1);
  });
});

describe("effects keyed on the tick number", () => {
  it("E5y sets the finetune of the note it sits on, and nothing without a note", () => {
    const buf = render([
      // E5C: finetune 12 * 16 - 128 = +64, half a semitone up.
      { ...NOTE, effect: E, effectParam: 0x5c },
      { effect: E, effectParam: 0x50 },
    ]);
    expect(pitch(buf, 0, 3)).toBeCloseTo(0.5, 1);
    expect(pitch(buf, 1, 3)).toBeCloseTo(0.5, 1);
  });

  it("Kxx keys off on tick xx, not at the start of the row", () => {
    const buf = render([NOTE, { effect: 0x14, effectParam: 0x03 }]);
    expect([0, 1, 2, 3, 4, 5].map((t) => level(buf, 1, t))).toEqual([
      64, 64, 64, 0, 0, 0,
    ]);
  });

  it("EDx holds the whole row back until tick x — volume column included", () => {
    const buf = render([
      NOTE,
      { ...NOTE, volumeColumn: 0x20, effect: E, effectParam: 0xd3 },
    ]);
    expect([0, 1, 2, 3, 4, 5].map((t) => level(buf, 1, t))).toEqual([
      64, 64, 64, 16, 16, 16,
    ]);
  });

  it("E9x retriggers every x ticks and restarts the instrument state", () => {
    // Blip shorter than a tick: each trigger is one audible tick.
    const blip = instrument(64);
    blip.samples[0] = {
      ...blip.samples[0]!,
      data: new Int8Array(64).fill(100),
      loopLength: 0,
      loopType: "none",
    };
    const buf = render([{ ...NOTE, effect: E, effectParam: 0x92 }], [blip]);
    const audible = [0, 1, 2, 3, 4, 5].filter((t) => {
      for (let i = t * TICK; i < (t + 1) * TICK; i++) {
        if (buf[i] !== 0) return true;
      }
      return false;
    });
    expect(audible).toEqual([0, 2, 4]);
  });

  it("volume-column panning puts the nibble in the high half", () => {
    // C8 → 0x80, dead centre: both channels equal. (C8 × 17 = 0x88 was
    // slightly right of centre.)
    let s = setXmInstrument(emptyXmSong(), 0, instrument(64));
    s = setXmCell(s, 0, 0, 0, { ...NOTE, volumeColumn: 0xc8 });
    const r = new XmReplayer(s, { sampleRate: SR });
    const l = new Float32Array(TICK * 4);
    const rr = new Float32Array(TICK * 4);
    r.process(l, rr, l.length);
    let pl = 0;
    let pr = 0;
    for (let i = TICK; i < l.length; i++) {
      pl = Math.max(pl, Math.abs(l[i]!));
      pr = Math.max(pr, Math.abs(rr[i]!));
    }
    expect(pl).toBeCloseTo(pr, 5);
  });
});
