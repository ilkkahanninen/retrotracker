import { describe, expect, it } from "vitest";

import {
  emptyXmInstrument,
  emptyXmPattern,
  emptyXmSong,
} from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";
import type { XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

const SR = 44100;
/** BPM 125 → 50 ticks/s → exactly 882 frames per tick at 44.1 kHz. */
const TICK = 882;
const E = 0x0e;

/** Song at speed 1 (one tick per row) with `patterns` 8-row patterns
 *  played in order, so a per-tick trace is a per-row trace. */
function song(patterns = 1): XmSong {
  const s = emptyXmSong();
  const orders = s.orders.slice();
  for (let i = 0; i < patterns; i++) orders[i] = i;
  return {
    ...s,
    defaultTempo: 1,
    songLength: patterns,
    orders,
    patterns: Array.from({ length: patterns }, () =>
      emptyXmPattern(8, s.channelCount),
    ),
  };
}

function fx(
  s: XmSong,
  pattern: number,
  row: number,
  channel: number,
  param: number,
): XmSong {
  return setXmCell(s, pattern, row, channel, {
    effect: E,
    effectParam: param,
  });
}

/** Play to the end (or `maxTicks`) and return "order:row" for every tick. */
function trace(s: XmSong, maxTicks = 500): string[] {
  const r = new XmReplayer(s, { sampleRate: SR });
  const l = new Float32Array(TICK);
  const rr = new Float32Array(TICK);
  const out: string[] = [];
  for (let i = 0; i < maxTicks; i++) {
    // The row advances lazily at the start of process(), so read the
    // position after rendering the tick it belongs to.
    r.process(l, rr, TICK);
    if (r.isFinished()) break;
    out.push(`${r.getOrderIndex()}:${r.getRow()}`);
  }
  return out;
}

const rows = (s: XmSong, maxTicks?: number) =>
  trace(s, maxTicks).map((p) => Number(p.split(":")[1]));

describe("E6x pattern loop", () => {
  it("E60 marks the start and E6y replays the span y more times", () => {
    let s = song();
    s = fx(s, 0, 2, 0, 0x60);
    s = fx(s, 0, 4, 0, 0x62);
    expect(rows(s)).toEqual([0, 1, 2, 3, 4, 2, 3, 4, 2, 3, 4, 5, 6, 7]);
  });

  it("loops from row 0 when no E60 was set", () => {
    const s = fx(song(), 0, 2, 0, 0x61);
    expect(rows(s)).toEqual([0, 1, 2, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps an independent counter per channel", () => {
    let s = song();
    // Channel 0 loops rows 0..1 once; channel 1 loops rows 0..3 once. The
    // outer pass replays the inner E61, which loops again on its own count.
    s = fx(s, 0, 1, 0, 0x61);
    s = fx(s, 0, 3, 1, 0x61);
    expect(rows(s)).toEqual([0, 1, 0, 1, 2, 3, 0, 1, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("can run again after it has completed (counter returns to 0)", () => {
    let s = song();
    s = fx(s, 0, 1, 0, 0x61);
    s = fx(s, 0, 2, 0, 0x60);
    s = fx(s, 0, 3, 0, 0x61);
    expect(rows(s)).toEqual([0, 1, 0, 1, 2, 3, 2, 3, 4, 5, 6, 7]);
  });

  it("starts the next pattern on the loop's start row (FT2 E60 bug)", () => {
    let s = song(2);
    s = fx(s, 0, 2, 0, 0x60);
    s = fx(s, 0, 3, 0, 0x61);
    const t = trace(s);
    expect(t.slice(0, 10)).toEqual([
      "0:0",
      "0:1",
      "0:2",
      "0:3",
      "0:2",
      "0:3",
      "0:4",
      "0:5",
      "0:6",
      "0:7",
    ]);
    // Pattern 1 is entered at row 2, not row 0 — and only this once.
    expect(t.slice(10)).toEqual(["1:2", "1:3", "1:4", "1:5", "1:6", "1:7"]);
  });

  it("a Dxx on the way out overrides the leftover start row", () => {
    let s = song(2);
    s = fx(s, 0, 2, 0, 0x60);
    s = fx(s, 0, 3, 0, 0x61);
    s = setXmCell(s, 0, 7, 0, { effect: 0x0d, effectParam: 0x05 });
    expect(trace(s).slice(10)).toEqual(["1:5", "1:6", "1:7"]);
  });

  it("an E60 between passes redirects that channel's next loop", () => {
    let s = song();
    s = fx(s, 0, 1, 0, 0x61); // ch 0: loop rows 0..1
    s = fx(s, 0, 2, 0, 0x60); // ch 0: new start row 2
    s = fx(s, 0, 2, 1, 0x61); // ch 1: loop rows 0..2
    // Second trip through row 1 re-arms ch 0, which now jumps to row 2.
    expect(rows(s)).toEqual([0, 1, 0, 1, 2, 0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("EEx pattern delay", () => {
  it("repeats the row x extra times", () => {
    const s = fx(song(), 0, 1, 0, 0xe2);
    expect(rows(s)).toEqual([0, 1, 1, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("EE0 is a no-op", () => {
    const s = fx(song(), 0, 1, 0, 0xe0);
    expect(rows(s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("the last channel's EEx wins when several share a row", () => {
    let s = song();
    s = fx(s, 0, 1, 0, 0xe3);
    s = fx(s, 0, 1, 1, 0xe1);
    expect(rows(s)).toEqual([0, 1, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a Dxx on a delayed row is taken after the delay and skips its target row", () => {
    // FT2 moves the position on the row's first tick but keeps replaying
    // the row from channel state, then steps on from the target — so the
    // target row itself (1:4) never plays.
    let s: XmSong = { ...song(2), defaultTempo: 3 };
    s = fx(s, 0, 1, 0, 0xe1);
    s = setXmCell(s, 0, 1, 1, { effect: 0x0d, effectParam: 0x04 });
    const t = trace(s, 12);
    // row 0 ×3 ticks, row 1 ×6 ticks (3 + one 3-tick repeat), then 1:5.
    expect(t).toEqual([
      ...Array(3).fill("0:0"),
      ...Array(6).fill("0:1"),
      ...Array(3).fill("1:5"),
    ]);
  });

  it("an E6x loop-back on a delayed row also lands one row past its start", () => {
    let s = song();
    s = fx(s, 0, 1, 0, 0x60);
    s = fx(s, 0, 3, 0, 0x61);
    s = fx(s, 0, 3, 1, 0xe1);
    // Row 3 is held once, loops back to row 1 but resumes at row 2; the
    // second time round the loop is spent and only the delay applies.
    expect(rows(s)).toEqual([0, 1, 2, 3, 3, 2, 3, 3, 4, 5, 6, 7]);
  });

  it("EDx fires again on every repeat of a row held by EEx", () => {
    // One-shot blip: it sounds once per trigger, so count the ticks that
    // have audio in them.
    let s: XmSong = { ...song(), defaultTempo: 4 };
    s = {
      ...s,
      instruments: [
        {
          ...emptyXmInstrument(),
          samples: [
            {
              name: "blip",
              data: new Int8Array(64).fill(100),
              bits: 8,
              loopStart: 0,
              loopLength: 0,
              loopType: "none",
              volume: 64,
              finetune: 0,
              panning: 128,
              relativeNote: 0,
            },
          ],
        },
      ],
    };
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: E,
      effectParam: 0xd2,
    });
    s = fx(s, 0, 0, 1, 0xe2);
    const r = new XmReplayer(s, { sampleRate: SR });
    const audible: number[] = [];
    const l = new Float32Array(TICK);
    const rr = new Float32Array(TICK);
    for (let t = 0; t < 12; t++) {
      r.process(l, rr, TICK);
      if (l.some((x) => x !== 0)) audible.push(t);
    }
    // Tick 2 of the first pass and of both repeats (4 ticks per pass).
    expect(audible).toEqual([2, 6, 10]);
  });

  it("runs continuous effects on the first tick of each repeat (FT2)", () => {
    // ft2-clone sends every tick of a repeated row through the non-zero-tick
    // effect handler. At speed 3 with EE1, A04 therefore slides on ticks
    // 1,2 of the first pass and 0,1,2 of the repeat: 5 steps, 64 → 44.
    // (libxmp skips the repeat's first tick and lands on 48.)
    const looped = (vol: Partial<Parameters<typeof setXmCell>[4]>) => {
      let s: XmSong = { ...song(), defaultTempo: 3 };
      const data = new Int8Array(64);
      for (let i = 0; i < 64; i++) data[i] = i < 32 ? 100 : -100;
      s = {
        ...s,
        instruments: [
          {
            ...emptyXmInstrument(),
            name: "sq",
            samples: [
              {
                name: "sq",
                data,
                bits: 8,
                loopStart: 0,
                loopLength: 64,
                loopType: "forward",
                volume: 64,
                finetune: 0,
                panning: 128,
                relativeNote: 0,
              },
            ],
          },
        ],
      };
      return setXmCell(s, 0, 0, 0, { note: 49, instrument: 1, ...vol });
    };
    const peakOfRow1 = (s: XmSong, skipTicks: number) => {
      const r = new XmReplayer(s, { sampleRate: SR });
      const skip = new Float32Array(TICK * skipTicks);
      r.process(skip, new Float32Array(skip.length), skip.length);
      // Second tick of row 1: past the anti-click ramp, nothing changing.
      const l = new Float32Array(TICK * 2);
      r.process(l, new Float32Array(l.length), l.length);
      expect(r.getRow()).toBe(1);
      let p = 0;
      for (let i = TICK; i < l.length; i++) p = Math.max(p, Math.abs(l[i]!));
      return p;
    };
    let slid = looped({ effect: 0x0a, effectParam: 0x04 });
    slid = fx(slid, 0, 0, 1, 0xe1);
    const at44 = looped({ volumeColumn: 0x10 + 44 });
    const at48 = looped({ volumeColumn: 0x10 + 48 });
    const got = peakOfRow1(slid, 6); // row 0 lasts 6 ticks with the delay
    expect(got).toBeCloseTo(peakOfRow1(at44, 3), 4);
    expect(got).not.toBeCloseTo(peakOfRow1(at48, 3), 2);
  });

  it("does not retrigger the row's note on the repeats", () => {
    // A one-shot sample shorter than a row: silent by the time the repeats
    // run, and it must stay silent through them.
    let s: XmSong = { ...song(), defaultTempo: 6 };
    const data = new Int8Array(64).fill(100);
    s = {
      ...s,
      instruments: [
        {
          ...emptyXmInstrument(),
          name: "blip",
          samples: [
            {
              name: "blip",
              data,
              bits: 8,
              loopStart: 0,
              loopLength: 0,
              loopType: "none",
              volume: 64,
              finetune: 0,
              panning: 128,
              relativeNote: 0,
            },
          ],
        },
      ],
    };
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: E,
      effectParam: 0xe2,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const n = TICK * 6;
    const l = new Float32Array(n);
    const rr = new Float32Array(n);
    const peak = () => {
      r.process(l, rr, n);
      let p = 0;
      for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(l[i]!));
      return p;
    };
    expect(peak()).toBeGreaterThan(0); // first pass: the blip sounds
    expect(r.getRow()).toBe(0);
    expect(peak()).toBe(0); // repeat 1
    expect(peak()).toBe(0); // repeat 2
  });
});
