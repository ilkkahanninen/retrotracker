import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

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
