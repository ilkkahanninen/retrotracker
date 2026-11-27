import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmNote, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

/**
 * Vibrato (4xy) and tremolo (7xy) against ft2-clone's `doVibrato` /
 * `tremolo`. Values are read back from the rendered audio per tick: pitch
 * from zero-crossing spacing, volume from the peak.
 */

const SR = 44100;
/** BPM 125 → exactly 882 frames per tick; default speed 6 ticks per row. */
const TICK = 882;
const LEN = 32;
const E = 0x0e;
/** Sample default volume: leaves headroom for tremolo to add. */
const VOL = 32;

function song(): XmSong {
  const data = new Int8Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const p = i / LEN;
    data[i] = Math.round(100 * (p < 0.5 ? 4 * p - 1 : 3 - 4 * p));
  }
  return setXmInstrument(emptyXmSong(), 0, {
    ...emptyXmInstrument(),
    samples: [
      {
        name: "tri",
        data,
        bits: 8,
        loopStart: 0,
        loopLength: LEN,
        loopType: "forward",
        volume: VOL,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
  });
}

type Rows = Array<Partial<XmNote>>;
const NOTE: Partial<XmNote> = { note: 49, instrument: 1 };

function render(rows: Rows): Float32Array {
  let s = song();
  rows.forEach((cell, r) => {
    s = setXmCell(s, 0, r, 0, cell);
  });
  const r = new XmReplayer(s, { sampleRate: SR });
  const buf = new Float32Array(TICK * 6 * rows.length);
  r.process(buf, new Float32Array(buf.length), buf.length);
  return buf;
}

/** Pitch in semitones above C-4 during tick `t` of `row`. */
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
  return 12 * Math.log2(hz / (8363 / LEN));
}

/** Voice volume (0..64) during tick `t` of `row`, from the peak after the
 *  anti-click ramp, scaled against a plain note at the default volume. */
function volume(buf: Float32Array, row: number, t: number): number {
  const start = (row * 6 + t) * TICK;
  let p = 0;
  for (let i = start + 300; i < start + TICK; i++) {
    p = Math.max(p, Math.abs(buf[i]!));
  }
  return Math.round((p / REFERENCE_PEAK) * VOL);
}
const REFERENCE_PEAK = (() => {
  const buf = render([NOTE]);
  let p = 0;
  for (let i = TICK; i < 5 * TICK; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
})();

const row = (
  buf: Float32Array,
  r: number,
  read: (b: Float32Array, r: number, t: number) => number,
) => [0, 1, 2, 3, 4, 5].map((t) => Number(read(buf, r, t).toFixed(1)) + 0);

/** Semitones for a period offset of `units` (64 per semitone). */
const st = (units: number) => Number((units / 64).toFixed(1)) + 0;

describe("4xy vibrato", () => {
  it("swings magnitude × depth >> 5 period units, pitch down first", () => {
    // 48F: 8 phase steps per tick, depth 15. Sine magnitudes at phases
    // 0, 8, 16, 24 are 0, 180, 255, 180 → 0, 84, 119, 84 period units.
    const buf = render([NOTE, { effect: 0x04, effectParam: 0x8f }]);
    expect(row(buf, 1, pitch)).toEqual([0, 0, st(-84), st(-119), st(-84), 0]);
  });

  it("holds the last offset through tick 0 of the next vibrato row", () => {
    const vib = { effect: 0x04, effectParam: 0x8f };
    const buf = render([NOTE, { ...vib, effectParam: 0x4f }, vib]);
    // Row 1 at speed 4 ends on phase 16 (magnitude 255); row 2 tick 0
    // repeats it instead of snapping back to the note.
    expect(pitch(buf, 1, 5)).toBeCloseTo(-119 / 64, 1);
    expect(pitch(buf, 2, 0)).toBeCloseTo(-119 / 64, 1);
  });

  it("drops the offset on a row that does not continue the vibrato", () => {
    const buf = render([NOTE, { effect: 0x04, effectParam: 0x4f }, {}]);
    expect(pitch(buf, 2, 0)).toBeCloseTo(0, 1);
  });

  it("E41 ramp: climbs for a half-cycle, then mirrors with the sign flipped", () => {
    const buf = render([
      { ...NOTE, effect: E, effectParam: 0x41 },
      { effect: 0x04, effectParam: 0x8f },
      { effect: 0x04, effectParam: 0x00 },
    ]);
    // Phases 0, 8, 16, 24: ramp = index << 3 = 0, 64, 128, 192, then the
    // second half-cycle is 255 - ramp with the opposite sign.
    const u = (m: number) => (m * 15) >> 5;
    expect(row(buf, 1, pitch)).toEqual([
      0,
      0,
      st(-u(64)),
      st(-u(128)),
      st(-u(192)),
      st(u(255)),
    ]);
    expect(pitch(buf, 2, 1)).toBeCloseTo(u(255 - 64) / 64, 1);
  });

  it("E42 and E43 are both square", () => {
    for (const select of [0x42, 0x43]) {
      const buf = render([
        { ...NOTE, effect: E, effectParam: select },
        { effect: 0x04, effectParam: 0x8f },
      ]);
      expect(row(buf, 1, pitch)).toEqual([
        0,
        st(-119),
        st(-119),
        st(-119),
        st(-119),
        st(119),
      ]);
    }
  });

  it("a new note restarts the phase by default", () => {
    const vib = { effect: 0x04, effectParam: 0x4f };
    const buf = render([NOTE, vib, { ...NOTE, ...vib, effectParam: 0 }]);
    // Tick 0 is left out: the sample restarting mid-cycle disturbs the
    // zero-crossing reading for that one tick.
    expect(row(buf, 2, pitch).slice(1)).toEqual(row(buf, 1, pitch).slice(1));
  });

  it("E44: a new note keeps the phase running", () => {
    const vib = { effect: 0x04, effectParam: 0x4f };
    const buf = render([
      { ...NOTE, effect: E, effectParam: 0x44 },
      vib,
      { ...NOTE, ...vib, effectParam: 0 },
    ]);
    // Row 1 used phases 0..16; row 2 carries on from 20 instead of 0.
    // Sine magnitudes at 20, 24, 28 are 235, 180, 97; phase 32 starts the
    // second half-cycle at 0.
    const u = (m: number) => (m * 15) >> 5;
    expect(row(buf, 2, pitch).slice(1)).toEqual([
      st(-u(235)),
      st(-u(180)),
      st(-u(97)),
      0,
      st(u(97)),
    ]);
  });
});

describe("7xy tremolo", () => {
  it("swings magnitude × depth >> 6 volume units, louder first", () => {
    // 784: sine magnitudes 0, 180, 255, 180 → 0, 11, 15, 11.
    const buf = render([NOTE, { effect: 0x07, effectParam: 0x84 }]);
    expect(row(buf, 1, volume)).toEqual([
      VOL,
      VOL,
      VOL + 11,
      VOL + 15,
      VOL + 11,
      VOL,
    ]);
  });

  it("keeps the last tremolo volume after the row, until the volume is set", () => {
    const buf = render([
      NOTE,
      { effect: 0x07, effectParam: 0x44 },
      {},
      { effect: 0x0c, effectParam: 0x10 },
    ]);
    expect(volume(buf, 1, 5)).toBe(VOL + 15);
    expect(volume(buf, 2, 3)).toBe(VOL + 15);
    expect(volume(buf, 3, 3)).toBe(0x10);
  });

  it("E72 and E73 are both square", () => {
    for (const select of [0x72, 0x73]) {
      const buf = render([
        { ...NOTE, effect: E, effectParam: select },
        { effect: 0x07, effectParam: 0x84 },
      ]);
      expect(row(buf, 1, volume)).toEqual([
        VOL,
        VOL + 15,
        VOL + 15,
        VOL + 15,
        VOL + 15,
        VOL - 15,
      ]);
    }
  });

  it("E71 ramp is mirrored by the vibrato phase, not the tremolo phase (FT2 bug)", () => {
    // No vibrato has run, so the vibrato phase sits in its first half and
    // the ramp is never mirrored: it climbs 0..+12, then 0..-12, instead
    // of forming a saw.
    const buf = render([
      { ...NOTE, effect: E, effectParam: 0x71 },
      { effect: 0x07, effectParam: 0x84 },
      { effect: 0x07, effectParam: 0x00 },
    ]);
    const u = (m: number) => (m * 4) >> 6;
    expect(row(buf, 1, volume)).toEqual([
      VOL,
      VOL,
      VOL + u(64),
      VOL + u(128),
      VOL + u(192),
      VOL,
    ]);
    expect(row(buf, 2, volume).slice(1, 4)).toEqual([
      VOL - u(64),
      VOL - u(128),
      VOL - u(192),
    ]);
  });

  it("E74: a new note keeps the phase running; without it the phase restarts", () => {
    const trem = { effect: 0x07, effectParam: 0x44 };
    const again = { ...NOTE, ...trem, effectParam: 0 };
    const restart = render([NOTE, trem, again]);
    expect(row(restart, 2, volume)).toEqual(row(restart, 1, volume));

    const keep = render([
      { ...NOTE, effect: E, effectParam: 0x74 },
      trem,
      again,
    ]);
    // Carries on from phase 20: magnitudes 235, 180, 97 → 14, 11, 6.
    expect(row(keep, 2, volume)).toEqual([
      VOL,
      VOL + 14,
      VOL + 11,
      VOL + 6,
      VOL,
      VOL - 6,
    ]);
  });
});
