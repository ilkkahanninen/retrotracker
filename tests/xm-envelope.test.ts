import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmEnvelope, XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

const SR = 44100;
const SAMPLES_PER_TICK = Math.ceil(SR / 50); // BPM 125

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

function withEnvelopes(
  inst: XmInstrument,
  volEnv: Partial<XmEnvelope>,
  panEnv: Partial<XmEnvelope> = {},
): XmInstrument {
  return {
    ...inst,
    volumeEnvelope: {
      enabled: false,
      sustainEnabled: false,
      loopEnabled: false,
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      points: [],
      ...volEnv,
    },
    panningEnvelope: {
      enabled: false,
      sustainEnabled: false,
      loopEnabled: false,
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      points: [],
      ...panEnv,
    },
  };
}

function songWith(inst: XmInstrument, fadeout = 0): XmSong {
  let s = emptyXmSong();
  s = setXmInstrument(s, 0, { ...inst, fadeout });
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return s;
}

function peakOverTail(
  replayer: XmReplayer,
  frames: number,
  tail: number,
): number {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  replayer.process(left, right, frames);
  let peak = 0;
  for (let i = frames - tail; i < frames; i++) {
    peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  }
  return peak;
}

describe("Volume envelope", () => {
  it("disabled envelope leaves voice at full volume", () => {
    const inst = loudSaw();
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    expect(peakOverTail(r, SAMPLES_PER_TICK, SAMPLES_PER_TICK)).toBeGreaterThan(
      0.4,
    );
  });

  it("envelope reaching 0 silences the voice gradually", () => {
    const inst = withEnvelopes(loudSaw(), {
      enabled: true,
      points: [
        { tick: 0, value: 64 },
        { tick: 6, value: 0 }, // drops to 0 over 6 ticks
      ],
    });
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    // First tick: env @ tick 0 = 64 → full audio. Last tick: env @ 6 = 0.
    const earlyPeak = peakOverTail(r, SAMPLES_PER_TICK, SAMPLES_PER_TICK);
    const r2 = new XmReplayer(songWith(inst), { sampleRate: SR });
    const lateTail = peakOverTail(r2, SAMPLES_PER_TICK * 7, SAMPLES_PER_TICK);
    expect(lateTail).toBeLessThan(earlyPeak);
  });

  it("sustain-enabled envelope holds at sustain point while key is on", () => {
    const inst = withEnvelopes(loudSaw(), {
      enabled: true,
      sustainEnabled: true,
      sustainPoint: 1,
      points: [
        { tick: 0, value: 64 },
        { tick: 2, value: 32 },
        { tick: 8, value: 0 },
      ],
    });
    // No key-off in this song → env should pin to point[1] (tick 2, value 32)
    // after a couple of ticks and stay there.
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const lateTail = peakOverTail(r, SAMPLES_PER_TICK * 30, SAMPLES_PER_TICK);
    // 32/64 of the saw amplitude (~0.5) → ~0.25.
    expect(lateTail).toBeGreaterThan(0.05);
    expect(lateTail).toBeLessThan(0.4);
  });
});

describe("Key-off + fadeout", () => {
  it("note 97 sets keyOff so fadeout starts dropping volume", () => {
    const inst = loudSaw();
    let s = songWith(inst, 0x1000); // big fadeout — silences within a few ticks
    s = setXmCell(s, 0, 1, 0, { note: 97 });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Render through row 0 (key on) and row 1 (key off, fade decays).
    // With fadeout = 0x1000, after ~8 ticks of decay (32768 / 4096) we're at 0.
    // The anti-click ramp leaves a tiny ramp-tail when transitioning to
    // silence — "silent" here means below the perceptible-click floor.
    const lateTail = peakOverTail(r, SAMPLES_PER_TICK * 14, SAMPLES_PER_TICK);
    expect(lateTail).toBeLessThan(0.01);
  });

  it("note 97 without fadeout AND without vol-env silences the voice immediately", () => {
    const inst = loudSaw(); // fadeout = 0, no envelope
    let s = songWith(inst);
    s = setXmCell(s, 0, 1, 0, { note: 97 });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Tick through row 0 (audible) then into row 1 (key-off snaps vol to 0).
    const lateTail = peakOverTail(r, SAMPLES_PER_TICK * 8, SAMPLES_PER_TICK);
    expect(lateTail).toBeLessThan(0.01);
  });

  it("Kxx is equivalent to note 97", () => {
    const inst = loudSaw();
    let s = songWith(inst);
    s = setXmCell(s, 0, 1, 0, { effect: 0x14, effectParam: 0 });
    const r = new XmReplayer(s, { sampleRate: SR });
    const lateTail = peakOverTail(r, SAMPLES_PER_TICK * 8, SAMPLES_PER_TICK);
    expect(lateTail).toBeLessThan(0.01);
  });
});

describe("Panning envelope", () => {
  it("centred envelope (32) leaves channels balanced", () => {
    const inst = withEnvelopes(
      loudSaw(),
      {},
      {
        enabled: true,
        points: [
          { tick: 0, value: 32 },
          { tick: 50, value: 32 },
        ],
      },
    );
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK);
    const right = new Float32Array(SAMPLES_PER_TICK);
    r.process(left, right, SAMPLES_PER_TICK);
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      peakL = Math.max(peakL, Math.abs(left[i]!));
      peakR = Math.max(peakR, Math.abs(right[i]!));
    }
    expect(peakL).toBeGreaterThan(0);
    expect(peakR).toBeGreaterThan(0);
  });

  it("pan envelope at 0 (full left) silences the right channel", () => {
    const inst = withEnvelopes(
      loudSaw(),
      {},
      {
        enabled: true,
        points: [
          { tick: 0, value: 0 },
          { tick: 50, value: 0 },
        ],
      },
    );
    const r = new XmReplayer(songWith(inst), { sampleRate: SR });
    const left = new Float32Array(SAMPLES_PER_TICK);
    const right = new Float32Array(SAMPLES_PER_TICK);
    r.process(left, right, SAMPLES_PER_TICK);
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      peakL = Math.max(peakL, Math.abs(left[i]!));
      peakR = Math.max(peakR, Math.abs(right[i]!));
    }
    // value 0 → offset -32, panning shifts hard left; the right channel
    // should be near silent (clamped to 0 panning).
    expect(peakL).toBeGreaterThan(peakR);
  });
});

describe("Lxx set envelope position", () => {
  it("L05 jumps the volume envelope tick to 5", () => {
    const inst = withEnvelopes(loudSaw(), {
      enabled: true,
      points: [
        { tick: 0, value: 64 },
        { tick: 10, value: 0 }, // linear drop
      ],
    });
    let s = songWith(inst);
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x15,
      effectParam: 5,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const earlyTail = peakOverTail(r, SAMPLES_PER_TICK, SAMPLES_PER_TICK);
    // L05 jumps the envelope to halfway through the linear ramp → ~32/64
    // → ~0.25 saw peak instead of the full ~0.5.
    expect(earlyTail).toBeGreaterThan(0.05);
    expect(earlyTail).toBeLessThan(0.4);
  });
});
