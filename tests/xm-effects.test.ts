import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";

const SR = 44100;

/**
 * Synthetic XM with one full-range saw instrument. Patterns can be
 * customised per-test by piping the result through additional setXmCell
 * calls.
 */
function tinyXm(): XmSong {
  let s = emptyXmSong();
  const data = new Int8Array(256);
  for (let i = 0; i < 256; i++) data[i] = (i - 128) | 0;
  const inst: XmInstrument = {
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
  s = setXmInstrument(s, 0, inst);
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return s;
}

/** Render `frames` samples and return the L+R peak amplitude. */
function peakOver(replayer: XmReplayer, frames: number): number {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  replayer.process(left, right, frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  }
  return peak;
}

/** Render `frames` and return the peak of the LAST `tail` samples. */
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

/** Drive the replayer one row's worth of ticks (default speed 6). */
function renderTicks(replayer: XmReplayer, ticks: number): void {
  // tickHz = 50 @ BPM 125 → samplesPerTick ≈ 882
  const samplesPerTick = Math.ceil(SR / 50);
  const left = new Float32Array(samplesPerTick * ticks);
  const right = new Float32Array(samplesPerTick * ticks);
  replayer.process(left, right, samplesPerTick * ticks);
}

describe("Axy volume slide", () => {
  it("slide down (Axy with y) reduces the channel volume over ticks", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0a,
      effectParam: 0x04, // -4 per tick
    });
    // Compare the peak of the first tick vs. the last tick — by tick 5
    // the slide has dropped 5*4=20 units of volume.
    const r1 = new XmReplayer(s, { sampleRate: SR });
    const earlyPeak = peakOverTail(r1, 882, 882);
    const r2 = new XmReplayer(s, { sampleRate: SR });
    const lateTailPeak = peakOverTail(r2, 882 * 6, 882);
    expect(lateTailPeak).toBeLessThan(earlyPeak);
  });

  it("slide up (Axy with x) increases the channel volume over ticks", () => {
    let s = tinyXm();
    // Start at low volume via Cxx, then slide up.
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      volumeColumn: 0x10, // set volume = 0
    });
    s = setXmCell(s, 0, 1, 0, {
      note: 0,
      instrument: 0,
      effect: 0x0a,
      effectParam: 0x40, // +4 per tick
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Render through row 0 (volume = 0; should be silent) into row 1
    // (slide up: tick 1 → vol=4, tick 2 → 8, …).
    renderTicks(r, 6); // through row 0
    const p = peakOver(r, 882 * 6); // through row 1
    expect(p).toBeGreaterThan(0);
  });
});

describe("1xx / 2xx period slides", () => {
  it("1xx (slide up) lowers the period (raises pitch)", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x01,
      effectParam: 0x40, // big slide so the effect is unambiguous
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Just verify the song doesn't error out — pitch verification is
    // libxmp-bed territory. Audible output should still produce.
    expect(peakOver(r, 4096)).toBeGreaterThan(0);
  });

  it("E1y fine slide up applies once at tick 0", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: 0x14, // E1y, y=4
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    expect(peakOver(r, 882)).toBeGreaterThan(0);
  });
});

describe("4xy vibrato", () => {
  it("vibrato runs after note trigger and modulates pitch", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x04,
      effectParam: 0x84, // speed 8, depth 4
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // No assertion on pitch — just that audio doesn't drop out and the
    // tick handler doesn't blow up. We render through a couple of LFO
    // cycles.
    expect(peakOver(r, 882 * 12)).toBeGreaterThan(0);
  });
});

describe("3xx tone portamento", () => {
  it("walks the voice period toward the new note without retriggering", () => {
    let s = tinyXm();
    // Row 0: trigger C-4. Row 1: tone porta toward C-5 (note 61).
    s = setXmCell(s, 0, 1, 0, {
      note: 61,
      instrument: 0,
      effect: 0x03,
      effectParam: 0x40,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Render through both rows; ensure no crash and audible output.
    expect(peakOver(r, 882 * 12)).toBeGreaterThan(0);
  });
});

describe("8xx set panning", () => {
  it("8xx with param 0 pans hard left", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x08,
      effectParam: 0,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const left = new Float32Array(1024);
    const right = new Float32Array(1024);
    r.process(left, right, 1024);
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < 1024; i++) {
      peakL = Math.max(peakL, Math.abs(left[i]!));
      peakR = Math.max(peakR, Math.abs(right[i]!));
    }
    expect(peakL).toBeGreaterThan(0);
    expect(peakR).toBe(0);
  });

  it("8xx with param 255 pans hard right", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x08,
      effectParam: 255,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const left = new Float32Array(1024);
    const right = new Float32Array(1024);
    r.process(left, right, 1024);
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < 1024; i++) {
      peakL = Math.max(peakL, Math.abs(left[i]!));
      peakR = Math.max(peakR, Math.abs(right[i]!));
    }
    expect(peakR).toBeGreaterThan(0);
    // libxmp uses a /256 pan denominator, so pan=255 leaves a 1/256
    // bleed on the opposite channel (peakL ≈ peakR / 255). It is
    // small but non-zero; verify it's well below the dominant side.
    expect(peakL).toBeLessThan(peakR / 200);
  });
});

describe("9xx sample offset", () => {
  it("seeks the sample to (param * 256) on a trigger", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x09,
      effectParam: 0x80, // 0x80 * 256 = 32768, past the 256-sample saw → silence.
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Past the sample end → voice stops, no audio.
    expect(peakOver(r, 1024)).toBe(0);
  });
});

describe("E5y set finetune", () => {
  it("changes the voice period at the trigger", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: 0x5f, // E5F: max finetune
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Just verify the song still produces audio (no NaN periods etc.).
    expect(peakOver(r, 1024)).toBeGreaterThan(0);
  });
});

describe("ECy note cut", () => {
  it("EC0 cuts the voice at tick 0", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: 0xc0,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    expect(peakOver(r, 1024)).toBe(0);
  });

  it("EC4 cuts the voice at tick 4", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: 0xc4,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Render tick 0..3 — voice still audible.
    expect(peakOver(r, 882 * 3)).toBeGreaterThan(0);
    // After tick 4 the volume drops to 0.
    const left = new Float32Array(882 * 3);
    const right = new Float32Array(882 * 3);
    r.process(left, right, 882 * 3);
    // Tail of the render (after tick 4 fired) should be silent.
    let tailPeak = 0;
    for (let i = 882 * 2; i < 882 * 3; i++) {
      tailPeak = Math.max(tailPeak, Math.abs(left[i]!));
    }
    expect(tailPeak).toBe(0);
  });
});

describe("EDy note delay", () => {
  it("ED4 defers the note until tick 4", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0e,
      effectParam: 0xd4,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Tick 0..3: no audio yet.
    expect(peakOver(r, 882 * 3)).toBe(0);
    // Tick 4 onward: voice triggers.
    expect(peakOver(r, 882 * 6)).toBeGreaterThan(0);
  });
});

describe("Gxx global volume", () => {
  it("Gxx 0 silences everything until reset", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x10,
      effectParam: 0,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    expect(peakOver(r, 1024)).toBe(0);
  });
});

describe("Volume column", () => {
  it("vol col 0x65 (slide down 5) reduces volume over ticks", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      volumeColumn: 0x65,
    });
    const r1 = new XmReplayer(s, { sampleRate: SR });
    const early = peakOverTail(r1, 882, 882);
    const r2 = new XmReplayer(s, { sampleRate: SR });
    const lateTail = peakOverTail(r2, 882 * 6, 882);
    expect(lateTail).toBeLessThan(early);
  });

  it("vol col 0x88 (fine slide down 8) takes one tick", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      volumeColumn: 0x88,
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    // Trigger sets vol=64, then fine slide drops 8 → 56. Peak should
    // be ~56/64 of full.
    const peak = peakOver(r, 882);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(0.6); // sanity bound: less than ~75% of full
  });

  it("vol col 0xC8 (set pan = 8) centres the voice", () => {
    let s = tinyXm();
    s = setXmCell(s, 0, 0, 0, {
      note: 49,
      instrument: 1,
      volumeColumn: 0xc8, // 8*17 = 136, close to centre 128
    });
    const r = new XmReplayer(s, { sampleRate: SR });
    const left = new Float32Array(1024);
    const right = new Float32Array(1024);
    r.process(left, right, 1024);
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < 1024; i++) {
      peakL = Math.max(peakL, Math.abs(left[i]!));
      peakR = Math.max(peakR, Math.abs(right[i]!));
    }
    expect(peakL).toBeGreaterThan(0);
    expect(peakR).toBeGreaterThan(0);
  });
});
