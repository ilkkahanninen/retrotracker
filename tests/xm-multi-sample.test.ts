import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import { speedTempoAtXm } from "~/core/xm/flatten";
import type { XmInstrument, XmSample, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

const SR = 44100;
const SAMPLES_PER_TICK = Math.ceil(SR / 50);

function makeSample(value: number, name: string): XmSample {
  const data = new Int8Array(256);
  for (let i = 0; i < 256; i++) data[i] = value;
  return {
    name,
    data,
    bits: 8,
    loopStart: 0,
    loopLength: 256,
    loopType: "forward",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
}

describe("Multi-sample instruments (keyMap)", () => {
  it("each key in the keyMap selects its corresponding sample", () => {
    // Instrument with two samples — sample 0 is loud, sample 1 is silent.
    const inst: XmInstrument = {
      ...emptyXmInstrument(),
      name: "drum kit",
      samples: [makeSample(100, "loud"), makeSample(0, "silent")],
      keyMap: new Uint8Array(96), // all-zero by default
    };
    // Route note 50 (C#4) to sample 1.
    inst.keyMap[49] = 1; // key 49 (note 50, 0-based) → sample 1

    let s = emptyXmSong();
    s = setXmInstrument(s, 0, inst);
    // Row 0: note 49 (key 48, sample 0 — loud)
    s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });

    const r1 = new XmReplayer(s, { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK);
    const right = new Float32Array(SAMPLES_PER_TICK);
    r1.process(left, right, SAMPLES_PER_TICK);
    let loudPeak = 0;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      loudPeak = Math.max(loudPeak, Math.abs(left[i]!));
    }
    expect(loudPeak).toBeGreaterThan(0);

    // Row 0: note 50 (key 49, sample 1 — silent)
    s = setXmCell(s, 0, 0, 0, { note: 50, instrument: 1 });
    const r2 = new XmReplayer(s, { sampleRate: SR });
    const left2 = new Float32Array(SAMPLES_PER_TICK);
    const right2 = new Float32Array(SAMPLES_PER_TICK);
    r2.process(left2, right2, SAMPLES_PER_TICK);
    let silentPeak = 0;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      silentPeak = Math.max(silentPeak, Math.abs(left2[i]!));
    }
    expect(silentPeak).toBe(0);
  });

  it("keyMap value out of range falls back to samples[0]", () => {
    const inst: XmInstrument = {
      ...emptyXmInstrument(),
      name: "drum kit",
      samples: [makeSample(100, "loud")], // only one sample
      keyMap: new Uint8Array(96),
    };
    inst.keyMap[48] = 7; // out of range
    let s = emptyXmSong();
    s = setXmInstrument(s, 0, inst);
    s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
    const r = new XmReplayer(s, { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK);
    const right = new Float32Array(SAMPLES_PER_TICK);
    r.process(left, right, SAMPLES_PER_TICK);
    let peak = 0;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    expect(peak).toBeGreaterThan(0); // fell back to sample 0
  });
});

describe("speedTempoAtXm", () => {
  function fresh(): XmSong {
    return emptyXmSong();
  }

  it("returns song defaults when no Fxx is on the path", () => {
    const s = fresh();
    const { speed, tempo } = speedTempoAtXm(s, 0, 0);
    expect(speed).toBe(s.defaultTempo);
    expect(tempo).toBe(s.defaultBpm);
  });

  it("picks up the latest Fxx before (order, row)", () => {
    let s = fresh();
    s = setXmCell(s, 0, 2, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0f,
      effectParam: 0x10, // speed = 16
    });
    s = setXmCell(s, 0, 5, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0f,
      effectParam: 100, // tempo = 100
    });
    const { speed, tempo } = speedTempoAtXm(s, 0, 10);
    expect(speed).toBe(16);
    expect(tempo).toBe(100);
  });

  it("ignores Fxx on the target row itself (exclusive scan)", () => {
    let s = fresh();
    s = setXmCell(s, 0, 5, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0f,
      effectParam: 0x10,
    });
    const { speed } = speedTempoAtXm(s, 0, 5);
    expect(speed).toBe(s.defaultTempo); // scan stops at the row, doesn't read it
  });

  it("F00 is ignored (stop-song marker, not a state change)", () => {
    let s = fresh();
    s = setXmCell(s, 0, 2, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0f,
      effectParam: 0x10,
    });
    s = setXmCell(s, 0, 3, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0f,
      effectParam: 0,
    });
    const { speed } = speedTempoAtXm(s, 0, 10);
    expect(speed).toBe(16); // F00 doesn't override
  });
});
