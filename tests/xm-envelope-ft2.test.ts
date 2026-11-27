import { describe, expect, it } from "vitest";

import {
  ENVELOPE_FULL,
  newEnvelopeState,
  releaseEnvelope,
  resetEnvelope,
  setEnvelopePosition,
  stepEnvelope,
} from "~/core/audio/xmEnvelope";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmEnvelope, XmInstrument, XmNote, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

/**
 * Envelope playback against ft2-clone's `updateVolPanAutoVib`,
 * `setEnvelopePos` and `keyOff`. Values are in 8.8 fixed point; `v(n)` is
 * the raw value for an envelope height of n.
 */

const v = (height: number) => height << 8;

function env(
  points: Array<[number, number]>,
  flags: Partial<XmEnvelope> = {},
): XmEnvelope {
  return {
    enabled: true,
    sustainEnabled: false,
    loopEnabled: false,
    sustainPoint: 0,
    loopStart: 0,
    loopEnd: 0,
    points: points.map(([tick, value]) => ({ tick, value })),
    ...flags,
  };
}

/** Run `ticks` steps, optionally releasing the key before step `offAt`. */
function run(e: XmEnvelope, ticks: number, offAt = Infinity): number[] {
  const st = newEnvelopeState();
  const out: number[] = [];
  for (let t = 0; t < ticks; t++) {
    if (t === offAt) releaseEnvelope(st, e);
    out.push(stepEnvelope(st, e, t >= offAt));
  }
  return out;
}

describe("envelope stepping", () => {
  it("the first step is point 0's value; segments are straight lines", () => {
    const e = env([
      [0, 0],
      [4, 64],
      [8, 32],
    ]);
    expect(run(e, 10)).toEqual([0, 16, 32, 48, 64, 56, 48, 40, 32, 32].map(v));
  });

  it("uses a truncated integer delta, then snaps to the point", () => {
    // 64 over 3 ticks: delta = trunc(16384 / 3) = 5461, so the run-up reads
    // 5461, 10922 — and then the point itself, 16384, not 16383.
    const e = env([
      [0, 0],
      [3, 64],
    ]);
    expect(run(e, 5)).toEqual([0, 5461, 10922, 16384, 16384]);
    // Falling: C division truncates towards zero, so -5461, not -5462.
    const f = env([
      [0, 64],
      [3, 0],
    ]);
    expect(run(f, 4)).toEqual([16384, 16384 - 5461, 16384 - 10922, 0]);
  });

  it("sustain holds on its point until the key is released", () => {
    const e = env(
      [
        [0, 64],
        [2, 32],
        [4, 0],
      ],
      { sustainEnabled: true, sustainPoint: 1 },
    );
    expect(run(e, 8)).toEqual([64, 48, 32, 32, 32, 32, 32, 32].map(v));
    // Released before step 6: the point is reached again, then it moves on.
    expect(run(e, 10, 6)).toEqual(
      [64, 48, 32, 32, 32, 32, 32, 16, 0, 0].map(v),
    );
  });

  it("a release before the sustain point is reached just runs through it", () => {
    const e = env(
      [
        [0, 64],
        [4, 32],
        [8, 0],
      ],
      { sustainEnabled: true, sustainPoint: 1 },
    );
    expect(run(e, 9, 1)).toEqual([64, 56, 48, 40, 32, 24, 16, 8, 0].map(v));
  });

  it("loops from the loop-end point back to the loop-start point", () => {
    const e = env(
      [
        [0, 64],
        [2, 0],
        [4, 64],
        [9, 0],
      ],
      { loopEnabled: true, loopStart: 1, loopEnd: 2 },
    );
    // Reaching point 2 (tick 4) jumps straight to point 1's value.
    expect(run(e, 9)).toEqual([64, 32, 0, 32, 0, 32, 0, 32, 0].map(v));
  });

  it("a loop that ends on the sustain point is left on key-off", () => {
    const e = env(
      [
        [0, 64],
        [2, 0],
        [4, 64],
        [6, 0],
      ],
      {
        loopEnabled: true,
        loopStart: 1,
        loopEnd: 2,
        sustainEnabled: true,
        sustainPoint: 2,
      },
    );
    // Held: it keeps looping. Released before step 5: next time point 2 is
    // reached the loop is skipped and the tail plays.
    expect(run(e, 9)).toEqual([64, 32, 0, 32, 0, 32, 0, 32, 0].map(v));
    expect(run(e, 9, 5)).toEqual([64, 32, 0, 32, 0, 32, 64, 32, 0].map(v));
  });

  it("a loop that does not end on the sustain point keeps looping after key-off", () => {
    const e = env(
      [
        [0, 64],
        [2, 0],
        [4, 64],
        [6, 0],
      ],
      { loopEnabled: true, loopStart: 1, loopEnd: 2 },
    );
    expect(run(e, 9, 3)).toEqual([64, 32, 0, 32, 0, 32, 0, 32, 0].map(v));
  });

  it("stays on the last point once the envelope has run out", () => {
    const e = env([
      [0, 64],
      [2, 16],
    ]);
    expect(run(e, 6)).toEqual([64, 40, 16, 16, 16, 16].map(v));
  });

  it("an envelope restart keeps the old value until point 0 is reached", () => {
    const e = env([
      [0, 48],
      [4, 0],
    ]);
    const st = newEnvelopeState();
    for (let i = 0; i < 3; i++) stepEnvelope(st, e, false);
    resetEnvelope(st);
    expect(st.tick).toBe(0xffff);
    expect(stepEnvelope(st, e, false)).toBe(v(48));
  });
});

describe("Lxx set envelope position", () => {
  const e = env([
    [0, 64],
    [20, 0],
  ]);

  it("lands mid-segment as if the envelope had been running", () => {
    const st = newEnvelopeState();
    setEnvelopePosition(st, e, 10);
    // delta = trunc(-16384 / 20) = -819; the step that follows is tick 10.
    expect(st.delta).toBe(-819);
    expect(stepEnvelope(st, e, false)).toBe(ENVELOPE_FULL - 819 * 10);
  });

  it("past the last point parks on it", () => {
    const st = newEnvelopeState();
    setEnvelopePosition(st, e, 40);
    expect(stepEnvelope(st, e, false)).toBe(0);
    expect(stepEnvelope(st, e, false)).toBe(0);
  });

  it("exactly on a point leaves the value and delta as they were (FT2)", () => {
    const three = env([
      [0, 64],
      [10, 32],
      [20, 0],
    ]);
    const st = newEnvelopeState();
    st.value = 1234;
    st.delta = 7;
    setEnvelopePosition(st, three, 10);
    expect([st.value, st.delta, st.pos]).toEqual([1234, 7, 1]);
    // The next step reaches point 1 and loads it properly.
    expect(stepEnvelope(st, three, false)).toBe(v(32));
  });
});

describe("envelopes in the replayer", () => {
  const SR = 44100;
  const TICK = 882;

  function instrument(patch: Partial<XmInstrument>): XmInstrument {
    const data = new Int8Array(32);
    for (let i = 0; i < 32; i++) data[i] = i < 16 ? 100 : -100;
    return {
      ...emptyXmInstrument(),
      ...patch,
      samples: [
        {
          name: "sq",
          data,
          bits: 8,
          loopStart: 0,
          loopLength: 32,
          loopType: "forward",
          volume: 64,
          finetune: 0,
          panning: 128,
          relativeNote: 0,
        },
      ],
    };
  }

  /** Peak per tick on the left and right outputs, 64 = full scale. */
  function levels(inst: XmInstrument, rows: Array<Partial<XmNote>>) {
    let s: XmSong = setXmInstrument(emptyXmSong(), 0, inst);
    rows.forEach((cell, r) => {
      s = setXmCell(s, 0, r, 0, cell);
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const n = TICK * 6 * rows.length;
    const l = new Float32Array(n);
    const rr = new Float32Array(n);
    r.process(l, rr, n);
    const peak = (buf: Float32Array, t: number) => {
      let p = 0;
      for (let i = t * TICK + 400; i < (t + 1) * TICK; i++) {
        p = Math.max(p, Math.abs(buf[i]!));
      }
      return p;
    };
    // A centred full-volume voice peaks at 100/128 / 2 per side.
    const unit = 100 / 128 / 2 / 64;
    const ticks = rows.length * 6;
    return {
      left: Array.from({ length: ticks }, (_, t) =>
        Math.round(peak(l, t) / unit),
      ),
      right: Array.from({ length: ticks }, (_, t) =>
        Math.round(peak(rr, t) / unit),
      ),
    };
  }

  const NOTE: Partial<XmNote> = { note: 49, instrument: 1 };
  const flat = env([
    [0, 64],
    [1, 64],
  ]);

  it("times a note on the first row and a note mid-song identically", () => {
    const ramp = instrument({
      volumeEnvelope: env([
        [0, 0],
        [4, 64],
      ]),
    });
    const { left } = levels(ramp, [NOTE, {}, NOTE]);
    expect(left.slice(0, 6)).toEqual([0, 16, 32, 48, 64, 64]);
    expect(left.slice(12, 18)).toEqual(left.slice(0, 6));
  });

  it("a panning envelope never leaves its sustain point after key-off (FT2 bug)", () => {
    const inst = instrument({
      volumeEnvelope: flat,
      panningEnvelope: env(
        [
          [0, 32],
          [2, 0],
          [6, 64],
        ],
        { sustainEnabled: true, sustainPoint: 1 },
      ),
    });
    const { right } = levels(inst, [NOTE, { note: 97 }, {}]);
    // Hard left from tick 2 on; the key-off on row 1 changes nothing.
    expect(right.slice(2, 18).every((x) => x === 0)).toBe(true);
  });

  it("a panning envelope at full scale on a centred voice is clamped right, not wrapped left", () => {
    const inst = instrument({
      panningEnvelope: env([
        [0, 64],
        [1, 64],
      ]),
    });
    const { left, right } = levels(inst, [NOTE]);
    // Panning 255 of 256: a trace is left on the left side.
    expect(left[3]).toBeLessThanOrEqual(1);
    expect(right[3]).toBeGreaterThan(120);
  });

  it("a hard-panned voice is not moved by its panning envelope", () => {
    const inst = instrument({
      panningEnvelope: env([
        [0, 64],
        [1, 64],
      ]),
    });
    inst.samples[0] = { ...inst.samples[0]!, panning: 0 };
    const { right } = levels(inst, [NOTE]);
    expect(right[3]).toBe(0);
  });

  it("Lxx moves the panning envelope only when the volume envelope has sustain on (FT2 bug)", () => {
    const sweep = env([
      [0, 0],
      [40, 64],
    ]);
    const L20: Array<Partial<XmNote>> = [
      { ...NOTE, effect: 0x15, effectParam: 40 },
    ];
    const without = instrument({
      volumeEnvelope: flat,
      panningEnvelope: sweep,
    });
    expect(levels(without, L20).right[3]).toBeLessThan(20);

    const withSustain = instrument({
      volumeEnvelope: { ...flat, sustainEnabled: true, sustainPoint: 1 },
      panningEnvelope: sweep,
    });
    expect(levels(withSustain, L20).right[3]).toBeGreaterThan(100);
  });
});
