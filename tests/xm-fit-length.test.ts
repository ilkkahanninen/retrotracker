import { beforeEach, describe, expect, it } from "vitest";

import {
  transformToXm,
  xmFitFrames,
  xmWorkbenchFromChiptune,
  xmWorkbenchFromWav,
  runXmPipeline,
  type XmTransformerParams,
} from "~/core/audio/sampleWorkbench";
import { XmReplayer } from "~/core/audio/xmReplayer";
import { xmC4Rate } from "~/core/audio/xmFreqTable";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { speedTempoAtXm } from "~/core/xm/flatten";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import { refitXmLoop, xmRenderTargetFor } from "~/core/xm/sampleFit";
import { tuneForSampleRate } from "~/core/xm/sampleImport";
import type { XmSample, XmSong } from "~/core/xm/types";
import {
  xmSampleSelection,
  setXmSampleSelection,
} from "~/state/xmSampleSelection";
import {
  canUndo,
  clearHistory,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "~/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "~/state/xmEdit";
import { patchXmSample } from "~/state/xmInstrumentEdit";
import {
  addXmEffect,
  setXmPlayingLength,
  setXmResampleMode,
} from "~/state/xmSampleEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
} from "~/state/xmSampleWorkbench";

/**
 * The FT2 length fit — "make this drum loop last exactly N rows at this
 * tempo". The pipeline resamples the sample to the frame count that,
 * read at the sample's own C-4 rate, lasts `ticks × 2.5 / bpm` seconds.
 */

const SR = 44100;

function wav(frames: number, sampleRate = SR) {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return { sampleRate, channels: [ch] };
}

const XM16: XmTransformerParams = { monoMix: "average", bitDepth: 16 };

describe("transformToXm length fit", () => {
  it("resamples to exactly round(seconds × c4Rate) frames", () => {
    // 64 rows at speed 6, 140 BPM: 384 ticks × 2.5 / 140 s.
    const xm = { ...XM16, playingLength: { ticks: 384, bpm: 140 } };
    for (const c4Rate of [8363, 22050, 44100, 44172.3]) {
      const out = transformToXm(wav(50_000), xm, { c4Rate });
      expect(out.data.length).toBe(Math.round(((384 * 2.5) / 140) * c4Rate));
    }
  });

  it("every resampler lands on the same frame count", () => {
    for (const resampleMode of ["linear", "filteredLinear", "sinc"] as const) {
      const out = transformToXm(
        wav(12_345),
        { ...XM16, resampleMode, playingLength: { ticks: 96, bpm: 125 } },
        { c4Rate: 44100 },
      );
      expect(out.data.length).toBe(Math.round(96 * 0.02 * 44100));
    }
  });

  it("leaves the length alone without a fit, or without a target", () => {
    expect(transformToXm(wav(1000), XM16, { c4Rate: 44100 }).data.length).toBe(
      1000,
    );
    const fitted = { ...XM16, playingLength: { ticks: 96, bpm: 125 } };
    expect(transformToXm(wav(1000), fitted).data.length).toBe(1000);
    expect(transformToXm(wav(1000), fitted, null).data.length).toBe(1000);
  });

  it("ignores a degenerate fit", () => {
    const target = { c4Rate: 44100 };
    expect(xmFitFrames({ ...XM16, playingLength: null }, target)).toBeNull();
    expect(
      xmFitFrames({ ...XM16, playingLength: { ticks: 0, bpm: 125 } }, target),
    ).toBeNull();
    expect(
      xmFitFrames({ ...XM16, playingLength: { ticks: 96, bpm: 0 } }, target),
    ).toBeNull();
  });

  it("a chiptune source ignores the fit", () => {
    const wb = xmWorkbenchFromChiptune();
    const plain = runXmPipeline(wb, null, { c4Rate: 44100 }).data.length;
    const fitted = runXmPipeline(
      { ...wb, xm: { ...wb.xm, playingLength: { ticks: 96, bpm: 125 } } },
      null,
      { c4Rate: 44100 },
    ).data.length;
    expect(fitted).toBe(plain);
  });
});

describe("a fitted sample lasts the fitted time in the replayer", () => {
  /** Frames of output the replayer produces before the note runs out. */
  function soundingFrames(sample: XmSample, linearFreq: boolean): number {
    let song: XmSong = { ...emptyXmSong(), flags: { linearFreq } };
    song = setXmInstrument(song, 0, {
      ...emptyXmInstrument(),
      samples: [sample],
    });
    song = setXmCell(song, 0, 0, 0, { note: 49, instrument: 1 });
    // A slow speed keeps the song on its first rows for the whole note.
    song = { ...song, defaultTempo: 31, defaultBpm: 32 };
    const r = new XmReplayer(song, {
      sampleRate: SR,
      loop: false,
      xmRamping: false,
      xmInterpolation: "none",
    });
    const total = SR * 4;
    const L = new Float32Array(total);
    r.process(L, new Float32Array(total), total);
    let last = -1;
    for (let i = 0; i < total; i++) if (L[i] !== 0) last = i;
    return last + 1;
  }

  for (const linearFreq of [true, false]) {
    it(`within a couple of frames (${linearFreq ? "linear" : "Amiga"} periods)`, () => {
      // A 44.1 kHz import, the way the importer tunes it.
      const tuning = tuneForSampleRate(44100);
      const target = xmRenderTargetFor(tuning, linearFreq)!;
      expect(target.c4Rate).toBe(
        xmC4Rate(tuning.relativeNote, tuning.finetune, linearFreq),
      );
      // 48 ticks at 150 BPM = 0.8 s. A constant, so every frame is audible.
      const source = {
        sampleRate: 44100,
        channels: [new Float32Array(30_000).fill(0.5)],
      };
      const wb = xmWorkbenchFromWav(source, "loop");
      const { data, bits } = runXmPipeline(
        { ...wb, xm: { ...wb.xm, playingLength: { ticks: 48, bpm: 150 } } },
        null,
        target,
      );
      const sample: XmSample = {
        ...emptyXmInstrument().samples[0]!,
        ...tuning,
        data,
        bits,
        volume: 64,
      };
      const want = ((48 * 2.5) / 150) * SR;
      expect(Math.abs(soundingFrames(sample, linearFreq) - want)).toBeLessThan(
        3,
      );
    });
  }
});

describe("refitXmLoop", () => {
  const loop = {
    loopStart: 100,
    loopLength: 300,
    loopType: "forward",
  } as const;

  it("clamp keeps frame positions and trims the overhang", () => {
    expect(refitXmLoop(loop, 400, 250, "clamp")).toEqual({
      loopStart: 100,
      loopLength: 150,
      loopType: "forward",
    });
  });

  it("scale moves both ends, so a loop to the last frame still is one", () => {
    expect(refitXmLoop(loop, 400, 1000, "scale")).toEqual({
      loopStart: 250,
      loopLength: 750,
      loopType: "forward",
    });
    expect(refitXmLoop(loop, 400, 201, "scale")).toEqual({
      loopStart: 50,
      loopLength: 151,
      loopType: "forward",
    });
  });

  it("a loop squeezed to nothing is switched off", () => {
    expect(refitXmLoop(loop, 400, 50, "clamp").loopType).toBe("none");
  });
});

describe("speedTempoAtXm inclusive", () => {
  it("includes an Fxx on the row itself only when asked", () => {
    const s = setXmCell(emptyXmSong(), 0, 5, 0, {
      effect: 0x0f,
      effectParam: 150,
    });
    expect(speedTempoAtXm(s, 0, 5).tempo).toBe(s.defaultBpm);
    expect(speedTempoAtXm(s, 0, 5, true).tempo).toBe(150);
    expect(speedTempoAtXm(s, 0, 6).tempo).toBe(150);
  });
});

describe("fit state: setXmPlayingLength", () => {
  const LEN = 4000;
  const tuning = tuneForSampleRate(22050);

  beforeEach(() => {
    const s = emptyXmSong();
    const inst = emptyXmInstrument();
    const data = new Int8Array(LEN);
    for (let i = 0; i < LEN; i++) data[i] = Math.round(Math.sin(i / 9) * 100);
    inst.samples[0] = {
      ...inst.samples[0]!,
      ...tuning,
      data,
      bits: 8,
      loopStart: 1000,
      loopLength: 3000,
      loopType: "forward",
    };
    s.instruments = [inst];
    setSong(s);
    setCurrentXmInstrument(1);
    setCurrentXmSampleIndex(0);
    setTransport("idle");
    setXmSampleSelection(null);
    clearAllXmWorkbenches();
    clearHistory();
  });

  const sample = () => xm2Song()!.instruments[0]!.samples[0]!;
  const rate = () => xmC4Rate(sample().relativeNote, sample().finetune, true)!;
  const framesFor = (ticks: number, bpm: number) =>
    Math.round(((ticks * 2.5) / bpm) * rate());

  it("resamples the sample to the fitted length and scales its loop", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    const want = framesFor(96, 125);
    expect(sample().data.length).toBe(want);
    expect(getXmWorkbench(1, 0)!.xm.playingLength).toEqual({
      ticks: 96,
      bpm: 125,
    });
    // The loop covered the last three quarters and still does.
    expect(sample().loopStart).toBe(Math.round(1000 * (want / LEN)));
    expect(sample().loopStart + sample().loopLength).toBe(want);
    expect(sample().loopType).toBe("forward");
  });

  it("scales the waveform selection with it", () => {
    setXmSampleSelection({ start: 1000, end: 2000 });
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    const ratio = framesFor(96, 125) / LEN;
    expect(xmSampleSelection()).toEqual({
      start: Math.round(1000 * ratio),
      end: Math.round(2000 * ratio),
    });
  });

  it("clearing the fit restores the original length and drops the key", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    setXmPlayingLength(null);
    expect(sample().data.length).toBe(LEN);
    expect("playingLength" in getXmWorkbench(1, 0)!.xm).toBe(false);
    expect(sample().loopStart).toBe(1000);
    expect(sample().loopLength).toBe(3000);
  });

  it("is one undo entry, and a repeat of the same fit records nothing", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    undo();
    expect(sample().data.length).toBe(LEN);
    expect(canUndo()).toBe(false);
  });

  it("a chain edit under a fit keeps the fitted length", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    addXmEffect("reverse");
    expect(sample().data.length).toBe(framesFor(96, 125));
  });

  it("changing the resampler keeps the length", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    setXmResampleMode("linear");
    expect(getXmWorkbench(1, 0)!.xm.resampleMode).toBe("linear");
    expect(sample().data.length).toBe(framesFor(96, 125));
  });

  it("retuning re-fits in the same undo step, so the loop still lasts as long", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    const before = sample().data.length;
    patchXmSample(1, { relativeNote: sample().relativeNote + 12 }, 0);
    // An octave up reads the data twice as fast: twice the frames.
    expect(sample().data.length).toBe(framesFor(96, 125));
    expect(sample().data.length).toBeGreaterThan(before * 1.9);
    expect(sample().loopStart + sample().loopLength).toBe(sample().data.length);
    undo();
    expect(sample().data.length).toBe(before);
    expect(sample().relativeNote).toBe(tuning.relativeNote);
  });

  it("a finetune nudge FT2 can't resolve doesn't re-run the fit", () => {
    setXmPlayingLength({ ticks: 96, bpm: 125 });
    const data = sample().data;
    // FT2 drops finetune's low three bits: +1 within a step is inaudible.
    const base = sample().finetune & ~7;
    patchXmSample(1, { finetune: base }, 0);
    const settled = sample().data;
    patchXmSample(1, { finetune: base + 1 }, 0);
    expect(sample().data).toBe(settled);
    expect(sample().finetune).toBe(base + 1);
    void data;
  });

  it("a retune without a fit doesn't touch the data", () => {
    const data = sample().data;
    patchXmSample(1, { relativeNote: 5 }, 0);
    expect(sample().data).toBe(data);
  });
});
