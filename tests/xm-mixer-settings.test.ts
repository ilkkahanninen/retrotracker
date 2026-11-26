/**
 * Regression: the "XM mixer interpolation" and "XM mixer ramping" settings
 * were stored and shown in Settings but read by nothing — the replayer
 * always mixed linear with the ramp on. Also covers the worklet mute
 * cache that dropped flags for channels beyond its current length.
 */
import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";
import type { ReplayerOptions, XmInterpolation } from "~/core/audio/types";
import { renderToBuffer } from "~/core/audio/offlineRender";
import {
  MAX_MUTE_CHANNELS,
  resizeMuteFlags,
  withMuteFlag,
} from "~/core/audio/channelMuteBuffer";

const SR = 44100;

/** One instrument: a single-cycle sine, `period` frames, looped. */
function sineSong(
  period: number,
  loopType: "forward" | "ping-pong" | "none" = "forward",
  cycles = 1,
): XmSong {
  const n = period * cycles;
  const data = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Math.round(Math.sin((2 * Math.PI * i) / period) * 100);
  }
  const inst: XmInstrument = {
    ...emptyXmInstrument(),
    name: "sine",
    samples: [
      {
        name: "sine",
        data,
        bits: 8,
        loopStart: 0,
        loopLength: loopType === "none" ? 0 : n,
        loopType,
        volume: 64,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
  };
  let s = setXmInstrument(emptyXmSong(), 0, inst);
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return s;
}

function render(
  song: XmSong,
  opts: Partial<ReplayerOptions> = {},
  frames = 4096,
): Float32Array {
  const r = new XmReplayer(song, { sampleRate: SR, loop: true, ...opts });
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  r.process(left, right, frames, 0);
  return left;
}

const rms = (a: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / (a.length - from));
};
const diffRms = (a: Float32Array, b: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s / (a.length - from));
};
/** Sum of squared sample-to-sample jumps — a cheap roughness measure. */
const roughness = (a: Float32Array, from: number) => {
  let s = 0;
  for (let i = from + 1; i < a.length; i++) s += (a[i]! - a[i - 1]!) ** 2;
  return s;
};

const MODES: XmInterpolation[] = ["none", "linear", "cubic", "sinc8"];
/** Skip the anti-click ramp-in at the start of the note. */
const SETTLED = 1024;

/**
 * `attack` frames of pre-loop data followed by one sine cycle of `period`
 * frames that loops. `attackLevel` fills the attack with a constant.
 */
function attackThenLoopSong(
  attackLevel: number,
  loopType: "forward" | "ping-pong",
  attack = 16,
  period = 32,
): XmSong {
  const data = new Int8Array(attack + period);
  data.fill(attackLevel, 0, attack);
  for (let i = 0; i < period; i++) {
    data[attack + i] = Math.round(Math.sin((2 * Math.PI * i) / period) * 100);
  }
  const base = sineSong(period, loopType);
  const inst = base.instruments[0]!;
  return setXmInstrument(base, 0, {
    ...inst,
    samples: [
      { ...inst.samples[0]!, data, loopStart: attack, loopLength: period },
    ],
  });
}

describe("XM mixer interpolation at the loop seam", () => {
  // Regression: at the loop start the multi-tap kernels read the samples
  // "behind" it from the pre-loop attack on every pass, not from the loop
  // itself — a periodic click the linear path doesn't have. Once the
  // voice is looping, what the attack contains must not matter.
  const FRAMES = 8192;
  // The attack + first loop pass is 48 source frames; at this note's
  // step that is well under 2048 output frames.
  const LOOPING = 2048;

  for (const loopType of ["forward", "ping-pong"] as const) {
    for (const mode of ["cubic", "sinc8"] as const) {
      it(`${mode}, ${loopType} loop: the attack doesn't leak into later passes`, () => {
        const quiet = render(
          attackThenLoopSong(0, loopType),
          { xmInterpolation: mode },
          FRAMES,
        );
        const loud = render(
          attackThenLoopSong(120, loopType),
          { xmInterpolation: mode },
          FRAMES,
        );
        expect(rms(quiet, LOOPING)).toBeGreaterThan(0.01);
        // The attack itself is audible up front…
        expect(
          diffRms(quiet.subarray(0, 256), loud.subarray(0, 256)),
        ).toBeGreaterThan(1e-3);
        // …and gone once the voice is in the loop.
        expect(diffRms(quiet, loud, LOOPING)).toBe(0);
      });
    }
  }
});

describe("XM mixer interpolation", () => {
  it("defaults to linear — omitting the option changes nothing", () => {
    const song = sineSong(32);
    expect(render(song)).toEqual(render(song, { xmInterpolation: "linear" }));
  });

  it("every mode produces sound, and no two modes produce the same output", () => {
    const song = sineSong(32);
    const outs = MODES.map((m) => render(song, { xmInterpolation: m }));
    for (const o of outs) {
      expect(o.every((v) => Number.isFinite(v))).toBe(true);
      expect(rms(o, SETTLED)).toBeGreaterThan(0.01);
    }
    for (let i = 0; i < outs.length; i++) {
      for (let j = i + 1; j < outs.length; j++) {
        expect(diffRms(outs[i]!, outs[j]!, SETTLED)).toBeGreaterThan(1e-5);
      }
    }
  });

  it("all modes agree on level (no gain change from the kernel)", () => {
    const song = sineSong(64);
    const ref = rms(render(song, { xmInterpolation: "linear" }), SETTLED);
    for (const m of MODES) {
      const level = rms(render(song, { xmInterpolation: m }), SETTLED);
      expect(Math.abs(level - ref) / ref).toBeLessThan(0.05);
    }
  });

  it("'none' is stair-stepped; interpolating modes are smoother", () => {
    // A 16-frame cycle played well below its native rate: each source
    // sample is held for several output frames without interpolation.
    const song = sineSong(16);
    const rough = (m: XmInterpolation) =>
      roughness(render(song, { xmInterpolation: m }), SETTLED);
    const none = rough("none");
    expect(rough("linear")).toBeLessThan(none);
    expect(rough("cubic")).toBeLessThan(none);
    expect(rough("sinc8")).toBeLessThan(none);
  });

  it.each(["forward", "ping-pong", "none"] as const)(
    "multi-tap modes stay bounded across a %s loop boundary",
    (loopType) => {
      const song = sineSong(16, loopType, 4);
      for (const m of ["cubic", "sinc8"] as const) {
        const out = render(song, { xmInterpolation: m }, 16384);
        expect(out.every((v) => Number.isFinite(v))).toBe(true);
        // A continuous sine through the loop point must not spike: the
        // looped signal stays near the level of the linear reference.
        const peak = out.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
        const refPeak = render(song, {}, 16384).reduce(
          (p, v) => Math.max(p, Math.abs(v)),
          0,
        );
        expect(peak).toBeLessThan(refPeak * 1.25);
      }
    },
  );

  it("can be switched on a running replayer", () => {
    const song = sineSong(16);
    const r = new XmReplayer(song, { sampleRate: SR, loop: true });
    const a = new Float32Array(2048);
    const b = new Float32Array(2048);
    const scratch = new Float32Array(2048);
    r.process(a, scratch, 2048, 0);
    r.setXmInterpolation("none");
    r.process(b, scratch, 2048, 0);
    // After the switch the output is stair-stepped: repeated samples.
    let repeats = 0;
    for (let i = 1; i < b.length; i++) if (b[i] === b[i - 1]) repeats++;
    let repeatsBefore = 0;
    for (let i = 1025; i < a.length; i++)
      if (a[i] === a[i - 1]) repeatsBefore++;
    expect(repeats).toBeGreaterThan(repeatsBefore + 100);
  });

  it("reaches the offline render (WAV / MP3 export path)", () => {
    const song = sineSong(16);
    const run = (m: XmInterpolation) =>
      renderToBuffer(song, {
        sampleRate: SR,
        maxSeconds: 0.2,
        stopOnSongEnd: false,
        xmInterpolation: m,
      }).left;
    expect(diffRms(run("none"), run("linear"), SETTLED)).toBeGreaterThan(1e-4);
  });
});

describe("XM mixer ramping", () => {
  /** DC sample, so output level directly shows the voice gain. */
  function dcSong(): XmSong {
    const inst: XmInstrument = {
      ...emptyXmInstrument(),
      name: "dc",
      samples: [
        {
          name: "dc",
          data: new Int8Array(64).fill(100),
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
    };
    let s = setXmInstrument(emptyXmSong(), 0, inst);
    s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
    return s;
  }

  it("on (default): the note fades in over the ramp window", () => {
    const out = render(dcSong(), {}, 2048);
    expect(Math.abs(out[0]!)).toBeLessThan(Math.abs(out[1500]!) * 0.1);
    expect(render(dcSong(), { xmRamping: true }, 2048)).toEqual(out);
  });

  it("off: the note starts at full gain on the first frame", () => {
    const out = render(dcSong(), { xmRamping: false }, 2048);
    expect(Math.abs(out[1500]!)).toBeGreaterThan(0.01);
    expect(Math.abs(out[0]!)).toBeCloseTo(Math.abs(out[1500]!), 5);
  });

  it("both settle to the same steady level", () => {
    const on = render(dcSong(), { xmRamping: true }, 2048);
    const off = render(dcSong(), { xmRamping: false }, 2048);
    expect(on[1500]!).toBeCloseTo(off[1500]!, 5);
  });
});

describe("worklet mute cache", () => {
  it("keeps a flag set for a channel beyond the current length", () => {
    // The pre-load state: 4 entries, user muted channel 6 of an 8-ch song.
    let flags = [false, false, false, false];
    flags = withMuteFlag(flags, 5, true);
    expect(flags[5]).toBe(true);
    // `load` then sizes the cache to the song — the flag must survive.
    flags = resizeMuteFlags(flags, 8);
    expect(flags).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("updates in place when the channel is in range", () => {
    const flags = [false, false, false, false];
    expect(withMuteFlag(flags, 2, true)).toBe(flags);
    expect(flags[2]).toBe(true);
  });

  it("ignores nonsense channels", () => {
    const flags = [false, false];
    expect(withMuteFlag(flags, -1, true)).toBe(flags);
    expect(withMuteFlag(flags, MAX_MUTE_CHANNELS, true)).toBe(flags);
    expect(withMuteFlag(flags, 1.5, true)).toBe(flags);
    expect(flags).toEqual([false, false]);
  });

  it("resize truncates, pads with false, and is a no-op at the same size", () => {
    const flags = [true, false, true, true, false, true];
    expect(resizeMuteFlags(flags, 4)).toEqual([true, false, true, true]);
    expect(resizeMuteFlags([true], 3)).toEqual([true, false, false]);
    expect(resizeMuteFlags(flags, 6)).toBe(flags);
  });

  it("a replayer built with the cached flags mutes channel 6 from frame 0", () => {
    let song = emptyXmSong();
    const src = sineSong(32);
    song = { ...song, channelCount: 8, instruments: src.instruments };
    song = {
      ...song,
      patterns: song.patterns.map((p) => ({
        ...p,
        rows: p.rows.map((row) => {
          const r = row.slice();
          while (r.length < 8) r.push({ ...r[0]! });
          return r;
        }),
      })),
    };
    song = setXmCell(song, 0, 0, 5, { note: 49, instrument: 1 });
    const flags = resizeMuteFlags(withMuteFlag([false], 5, true), 8);
    expect(rms(render(song, { mutedChannels: flags }))).toBe(0);
    expect(rms(render(song))).toBeGreaterThan(0.01);
  });
});
