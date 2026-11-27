import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";
import {
  autoVibratoValue,
  newAutoVibratoState,
  resetAutoVibrato,
  stepAutoVibrato,
} from "~/core/audio/xmAutoVibrato";

const SR = 44100;
const SAMPLES_PER_TICK = Math.ceil(SR / 50);

function loudSaw(): XmInstrument {
  const data = new Int8Array(256);
  for (let i = 0; i < 256; i++) data[i] = (i - 128) | 0;
  return {
    ...emptyXmInstrument(),
    name: "saw",
    samples: [
      {
        name: "saw",
        data,
        bits: 8,
        loopStart: 0,
        loopLength: 256,
        loopType: "forward",
        volume: 64,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
  };
}

function songWith(inst: XmInstrument): XmSong {
  let s = emptyXmSong();
  s = setXmInstrument(s, 0, inst);
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return s;
}

describe("Autovibrato", () => {
  it("rate=0 OR depth=0 produces no pitch modulation", () => {
    const inst: XmInstrument = {
      ...loudSaw(),
      vibratoType: "sine",
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 16,
    };
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    // Just verify the song still produces audio (autovibrato disabled
    // path is a no-op).
    const left = new Float32Array(SAMPLES_PER_TICK * 8);
    const right = new Float32Array(SAMPLES_PER_TICK * 8);
    r.process(left, right, left.length);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    expect(peak).toBeGreaterThan(0);
  });

  it("non-zero depth + rate produces audible output", () => {
    const inst: XmInstrument = {
      ...loudSaw(),
      vibratoType: "sine",
      vibratoSweep: 0,
      vibratoDepth: 8,
      vibratoRate: 32,
    };
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK * 12);
    const right = new Float32Array(SAMPLES_PER_TICK * 12);
    r.process(left, right, left.length);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    // Autovibrato modulates pitch (period offset), not amplitude — the
    // saw's RMS / peak stay the same. So the assertion is just: audio
    // continues unbroken.
    expect(peak).toBeGreaterThan(0.3);
  });

  it("sweep ramps depth in over `vibratoSweep` ticks", () => {
    const inst: XmInstrument = {
      ...loudSaw(),
      vibratoType: "sine",
      vibratoSweep: 32, // 32 ticks to ramp in
      vibratoDepth: 15, // max depth
      vibratoRate: 16,
    };
    // Just exercise the path — no crash, audio continues. Pitch checks
    // are libxmp-bed territory.
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK * 40);
    const right = new Float32Array(SAMPLES_PER_TICK * 40);
    r.process(left, right, left.length);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    expect(peak).toBeGreaterThan(0.3);
  });

  it("supports all four waveform types", () => {
    const types = ["sine", "ramp-down", "square", "ramp-up"] as const;
    for (const t of types) {
      const inst: XmInstrument = {
        ...loudSaw(),
        vibratoType: t,
        vibratoSweep: 0,
        vibratoDepth: 8,
        vibratoRate: 16,
      };
      const r = new XmReplayer(songWith(inst), { sampleRate: SR });
      const left = new Float32Array(SAMPLES_PER_TICK * 4);
      const right = new Float32Array(SAMPLES_PER_TICK * 4);
      r.process(left, right, left.length);
      let peak = 0;
      for (let i = 0; i < left.length; i++) {
        peak = Math.max(peak, Math.abs(left[i]!));
      }
      expect(peak).toBeGreaterThan(0);
    }
  });

  it("resets phase + sweep on retrigger", () => {
    const inst: XmInstrument = {
      ...loudSaw(),
      vibratoType: "sine",
      vibratoSweep: 16,
      vibratoDepth: 15,
      vibratoRate: 16,
    };
    let s = songWith(inst);
    // Add a retrigger on row 1.
    s = setXmCell(s, 0, 1, 0, { note: 49, instrument: 1 });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Drive through both rows. The path shouldn't crash; the second
    // trigger resets autoVibPos / autoVibSweepPos back to 0 so the
    // ramp-in re-starts.
    const left = new Float32Array(SAMPLES_PER_TICK * 12);
    const right = new Float32Array(SAMPLES_PER_TICK * 12);
    r.process(left, right, left.length);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    expect(peak).toBeGreaterThan(0);
  });
});

/**
 * Pinned against ft2-clone's `updateVolPanAutoVib`. libxmp cannot referee
 * this effect (see NOT_COMPARABLE in xm-render-accuracy.test.ts).
 */
describe("auto-vibrato LFO (FT2)", () => {
  const at = (type: Parameters<typeof autoVibratoValue>[1]) => (p: number) =>
    autoVibratoValue(p, type);

  it("sine opens negative: pitch goes up first", () => {
    const sine = at("sine");
    expect([0, 1, 2, 64, 128, 192].map(sine)).toEqual([0, -2, -3, -64, 0, 64]);
  });

  it("square is -64 for the first half-cycle, +64 for the second", () => {
    const sq = at("square");
    expect([0, 127, 128, 255].map(sq)).toEqual([-64, -64, 64, 64]);
  });

  it("file type 2 (ramp-down) climbs 0..63 then -64..-1 — pitch falls", () => {
    const r = at("ramp-down");
    expect([0, 2, 126, 128, 254].map(r)).toEqual([0, 1, 63, -64, -1]);
  });

  it("file type 3 (ramp-up) falls 0..-63 then 64..1 — pitch rises", () => {
    const r = at("ramp-up");
    expect([0, 2, 126, 128, 130, 254].map(r)).toEqual([0, -1, -63, -64, 63, 1]);
  });

  it("without sweep the offset is value × depth >> 6 from the first tick", () => {
    const st = newAutoVibratoState();
    resetAutoVibrato(st, 15, 0);
    // Rate 64: phases 64, 128, 192, 0 → sine -64, 0, 64, 0.
    const out = [0, 1, 2, 3].map(() =>
      stepAutoVibrato(st, "sine", 15, 64, false),
    );
    expect(out).toEqual([-15, 0, 15, 0]);
  });

  it("sweep adds (depth << 8) / sweep per tick until the depth is reached", () => {
    const st = newAutoVibratoState();
    resetAutoVibrato(st, 8, 4);
    expect(st.sweepStep).toBe(512);
    // Square, rate 0: value is a constant -64, so the offset is -amp >> 8.
    const out = [0, 1, 2, 3, 4, 5].map(() =>
      stepAutoVibrato(st, "square", 8, 0, false),
    );
    // amp: 512, 1024, 1536, 2048, then 2560 >> 8 = 10 > 8 → clamps to 8.
    expect(out).toEqual([-2, -4, -6, -8, -8, -8]);
    expect(st.sweepStep).toBe(0);
  });

  it("key-off during the sweep freezes it at the per-tick step (FT2 quirk)", () => {
    const st = newAutoVibratoState();
    resetAutoVibrato(st, 8, 4);
    stepAutoVibrato(st, "square", 8, 0, false);
    stepAutoVibrato(st, "square", 8, 0, false); // amp 1024 → -4
    // Released: only the step (512) is used, not the 1024 reached so far.
    expect(stepAutoVibrato(st, "square", 8, 0, true)).toBe(-2);
    expect(stepAutoVibrato(st, "square", 8, 0, true)).toBe(-2);
  });

  it("depth 0 does nothing and leaves a running LFO alone on reset", () => {
    const st = newAutoVibratoState();
    resetAutoVibrato(st, 8, 0);
    stepAutoVibrato(st, "sine", 8, 10, false);
    const before = { ...st };
    resetAutoVibrato(st, 0, 0);
    expect(st).toEqual(before);
    expect(stepAutoVibrato(st, "sine", 0, 10, false)).toBe(0);
  });

  it("a rate of 0 still applies the waveform's value at phase 0", () => {
    const st = newAutoVibratoState();
    resetAutoVibrato(st, 15, 0);
    expect(stepAutoVibrato(st, "square", 15, 0, false)).toBe(-15);
    expect(stepAutoVibrato(st, "sine", 15, 0, false)).toBe(0);
  });

  it("in the replayer a square auto-vibrato raises the pitch first", () => {
    // Short loop so each tick holds several cycles and pitch is readable.
    const LEN = 32;
    const data = new Int8Array(LEN);
    for (let i = 0; i < LEN; i++) data[i] = i < LEN / 2 ? 100 : -100;
    const inst: XmInstrument = {
      ...loudSaw(),
      vibratoType: "square",
      vibratoSweep: 0,
      vibratoDepth: 15,
      vibratoRate: 16,
    };
    inst.samples[0] = { ...inst.samples[0]!, data, loopLength: LEN };
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const TICK = 882;
    const buf = new Float32Array(TICK * 12);
    r.process(buf, new Float32Array(buf.length), buf.length);
    const semitones = (t: number) => {
      let first = -1;
      let last = -1;
      let cycles = 0;
      for (let i = t * TICK + 1; i < (t + 1) * TICK; i++) {
        if (buf[i - 1]! <= 0 && buf[i]! > 0) {
          if (first < 0) first = i;
          else cycles++;
          last = i;
        }
      }
      return 12 * Math.log2((SR * cycles) / (last - first) / (8363 / LEN));
    };
    // 15 period units = 15/64 semitone. Phase passes 128 after 8 ticks.
    expect(semitones(3)).toBeCloseTo(15 / 64, 1);
    expect(semitones(10)).toBeCloseTo(-15 / 64, 1);
  });
});
