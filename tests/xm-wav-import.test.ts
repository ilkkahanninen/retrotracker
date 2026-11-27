import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { XmReplayer } from "~/core/audio/xmReplayer";
import { xmC4Rate } from "~/core/audio/xmFreqTable";
import { writeWav, type WavData } from "~/core/audio/wav";
import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import {
  isXmInstrumentEmpty,
  nextFreeXmInstrumentIndex,
  setXmCell,
  setXmInstrument,
} from "~/core/xm/mutations";
import { buildXmWavImport, tuneForSampleRate } from "~/core/xm/sampleImport";
import type { XmSong } from "~/core/xm/types";
import {
  dropWavsToXmInstrumentView,
  dropWavsToXmPatternView,
  loadWavsIntoXmSlot,
} from "~/state/dropImport";
import { clearXmSelection, setXmSelection } from "~/state/selection";
import {
  canUndo,
  clearHistory,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "~/state/song";
import {
  currentXmInstrument,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "~/state/xmEdit";
import { addXmSample, clearXmInstrument } from "~/state/xmInstrumentEdit";
import {
  bounceXmSelectionToInstrument,
  copyXmSampleRange,
  loadXmWavIntoCurrentSample,
  pasteXmSampleBytes,
  setXmSourceKind,
  updateXmChiptune,
} from "~/state/xmSampleEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
} from "~/state/xmSampleWorkbench";

/**
 * FT2 WAV import: every path keeps the WAV as decoded as the pipeline
 * source and tunes the sample from the WAV's own rate, so C-4 plays it
 * at original speed.
 */

function wav(frames: number, sampleRate = 44100, channels = 1): WavData {
  return {
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) => {
      const ch = new Float32Array(frames);
      for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / (4 + c)) * 0.5;
      return ch;
    }),
  };
}
const bytes = (w: WavData) => writeWav(w, { bitsPerSample: 16 });
const file = (name: string, w: WavData = wav(64)) =>
  new File([bytes(w) as unknown as BlobPart], name, { type: "audio/wav" });

const inst = (n = 1) => xm2Song()!.instruments[n - 1]!;
const sample = (n = 1, idx = 0) => inst(n).samples[idx]!;
const tuning = (n = 1, idx = 0) => ({
  relativeNote: sample(n, idx).relativeNote,
  finetune: sample(n, idx).finetune,
});
const source = (n = 1, idx = 0) => {
  const wb = getXmWorkbench(n, idx);
  return wb?.source.kind === "sampler" ? wb.source : undefined;
};

function reset(song: XmSong = emptyXmSong()): void {
  setSong(song);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearXmSelection();
  clearAllXmWorkbenches();
  clearHistory();
}
beforeEach(() => reset());
afterEach(() => {
  setSong(null);
  clearHistory();
});

describe("tuneForSampleRate", () => {
  it("lands within half a finetune step of the rate in both modes", () => {
    // Half of a 1/16-semitone step, as a frequency ratio.
    const halfStep = Math.pow(2, 1 / 384);
    for (const linear of [true, false]) {
      for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 96000]) {
        const t = tuneForSampleRate(rate, linear);
        const got = xmC4Rate(t.relativeNote, t.finetune, linear)!;
        const ratio = got > rate ? got / rate : rate / got;
        expect(ratio).toBeLessThanOrEqual(halfStep * 1.0005);
      }
    }
  });

  it("never returns a negative zero", () => {
    for (const rate of [8363, 4181.5, 16726]) {
      const t = tuneForSampleRate(rate);
      expect(Object.is(t.relativeNote, -0)).toBe(false);
      expect(Object.is(t.finetune, -0)).toBe(false);
    }
  });
});

describe("buildXmWavImport", () => {
  it("keeps the WAV as decoded as the workbench source", () => {
    const stereo = wav(200, 48000, 2);
    const { wb, sample: s } = buildXmWavImport(stereo, "pad", true);
    expect(wb.source).toEqual({
      kind: "sampler",
      wav: stereo,
      sourceName: "pad",
    });
    // The sample is the mono mix, tuned for 48 kHz.
    expect(s.data.length).toBe(200);
    expect(s.bits).toBe(16);
    expect(s).toMatchObject(tuneForSampleRate(48000));
    expect(s.loopType).toBe("none");
  });

  it("keeps volume and panning of the sample it replaces, not its tuning", () => {
    const { sample: s } = buildXmWavImport(wav(50), "x", true, {
      keep: { volume: 20, panning: 200 },
    });
    expect(s.volume).toBe(20);
    expect(s.panning).toBe(200);
    expect(s).toMatchObject(tuneForSampleRate(44100));
  });
});

describe("Load WAV", () => {
  it("resets the tuning of the sample it replaces", () => {
    // The pitch bug: a cleared or freshly added sample has tuning 0 / 0,
    // and Load WAV used to keep it — a 44.1 kHz WAV then played at
    // 8363 Hz, about 29 semitones low.
    loadXmWavIntoCurrentSample(bytes(wav(100)), "a.wav");
    clearXmInstrument(1);
    expect(tuning()).toEqual({ relativeNote: 0, finetune: 0 });
    loadXmWavIntoCurrentSample(bytes(wav(100)), "b.wav");
    expect(tuning()).toEqual(tuneForSampleRate(44100));

    addXmSample(1);
    setCurrentXmSampleIndex(1);
    loadXmWavIntoCurrentSample(bytes(wav(100, 22050)), "c.wav");
    expect(tuning(1, 1)).toEqual(tuneForSampleRate(22050));
  });

  it("the source is the real WAV: stereo, at its own rate", () => {
    loadXmWavIntoCurrentSample(bytes(wav(300, 48000, 2)), "wide.wav");
    expect(source()!.wav.sampleRate).toBe(48000);
    expect(source()!.wav.channels).toHaveLength(2);
    expect(sample().data.length).toBe(300);
  });

  it("keeps a chiptune the slot had as the alt, with its own tuning", () => {
    setXmSourceKind("chiptune");
    updateXmChiptune({ cycleFrames: 128 });
    const chiptune = getXmWorkbench(1, 0)!.source;
    loadXmWavIntoCurrentSample(bytes(wav(100)), "a.wav");
    expect(getXmWorkbench(1, 0)!.alt?.source).toBe(chiptune);

    // Toggling back restores the synth and its 0 / 0 tuning; toggling
    // forward again restores the WAV's.
    setXmSourceKind("chiptune");
    expect(getXmWorkbench(1, 0)!.source).toBe(chiptune);
    expect(tuning()).toEqual({ relativeNote: 0, finetune: 0 });
    setXmSourceKind("sampler");
    expect(tuning()).toEqual(tuneForSampleRate(44100));
  });
});

describe("source-kind toggle and tuning", () => {
  it("a fresh chiptune plays at 0 / 0, not at the WAV's tuning", () => {
    loadXmWavIntoCurrentSample(bytes(wav(100)), "a.wav");
    setXmSourceKind("chiptune");
    expect(tuning()).toEqual({ relativeNote: 0, finetune: 0 });
    setXmSourceKind("sampler");
    expect(tuning()).toEqual(tuneForSampleRate(44100));
  });
});

describe("dropping WAVs on the instrument list", () => {
  const populated = (name: string) => {
    const i = emptyXmInstrument();
    i.name = name;
    i.samples[0] = { ...i.samples[0]!, data: new Int8Array([1, 2, 3]) };
    return i;
  };

  it("extra files go to the next FREE slots, never over populated ones", async () => {
    let s = emptyXmSong();
    s = setXmInstrument(s, 1, populated("keep-2"));
    s = setXmInstrument(s, 3, populated("keep-4"));
    reset(s);
    await loadWavsIntoXmSlot(1, [file("a.wav"), file("b.wav"), file("c.wav")]);
    expect(xm2Song()!.instruments.map((i) => i.name)).toEqual([
      "a",
      "keep-2",
      "b",
      "keep-4",
      "c",
    ]);
    expect(currentXmInstrument()).toBe(1);
  });

  it("names the instrument from the file and gives each a workbench", async () => {
    await loadWavsIntoXmSlot(2, [file("kick.wav"), file("snare.wav")]);
    expect(inst(2).name).toBe("kick");
    expect(inst(3).name).toBe("snare");
    expect(source(2)!.sourceName).toBe("kick");
    expect(source(3)!.sourceName).toBe("snare");
    expect(tuning(2)).toEqual(tuneForSampleRate(44100));
  });

  it("replaces the target slot with a fresh instrument", async () => {
    const old = populated("old");
    old.fadeout = 999;
    reset(setXmInstrument(emptyXmSong(), 0, old));
    await loadWavsIntoXmSlot(1, [file("new.wav")]);
    expect(inst().name).toBe("new");
    expect(inst().fadeout).toBe(emptyXmInstrument().fadeout);
    expect(inst().samples).toHaveLength(1);
  });

  it("the whole batch is one undo entry", async () => {
    await loadWavsIntoXmSlot(1, [file("a.wav"), file("b.wav"), file("c.wav")]);
    undo();
    expect(canUndo()).toBe(false);
    expect(nextFreeXmInstrumentIndex(xm2Song()!)).toBe(0);
    expect(getXmWorkbench(1, 0)).toBeUndefined();
  });
});

describe("dropping WAVs on the instrument view / pattern view", () => {
  it("an empty slot becomes one multi-sample instrument with workbenches", async () => {
    await dropWavsToXmInstrumentView([
      file("a.wav"),
      file("b.wav", wav(64, 22050)),
    ]);
    expect(inst().samples.map((s) => s.name)).toEqual(["a", "b"]);
    expect(source(1, 0)!.sourceName).toBe("a");
    expect(source(1, 1)!.wav.sampleRate).toBe(22050);
    expect(tuning(1, 1)).toEqual(tuneForSampleRate(22050));
    undo();
    expect(canUndo()).toBe(false);
  });

  it("a populated slot gets the files appended, in one undo entry", async () => {
    loadXmWavIntoCurrentSample(bytes(wav(100)), "first.wav");
    clearHistory();
    await dropWavsToXmInstrumentView([file("a.wav"), file("b.wav")]);
    expect(inst().samples.map((s) => s.name)).toEqual(["first", "a", "b"]);
    expect(source(1, 2)!.sourceName).toBe("b");
    undo();
    expect(inst().samples).toHaveLength(1);
    expect(canUndo()).toBe(false);
  });

  it("the pattern-view drop fills the first free slot", async () => {
    loadXmWavIntoCurrentSample(bytes(wav(100)), "first.wav");
    await dropWavsToXmPatternView([file("hat.wav")]);
    expect(inst(2).name).toBe("hat");
    expect(source(2)!.sourceName).toBe("hat");
    expect(currentXmInstrument()).toBe(2);
  });
});

describe("paste", () => {
  it("carries the copied sample's tuning and clears the old loop", () => {
    loadXmWavIntoCurrentSample(bytes(wav(100)), "a.wav");
    copyXmSampleRange(0, 40);
    // Paste into a second, untuned, looped sample.
    addXmSample(1);
    setCurrentXmSampleIndex(1);
    pasteXmSampleBytes();
    expect(sample(1, 1).data.length).toBe(40);
    expect(tuning(1, 1)).toEqual(tuneForSampleRate(44100));
    expect(sample(1, 1).loopType).toBe("none");
    // The workbench reports the rate the bytes will play at.
    expect(source(1, 1)!.wav.sampleRate).toBeCloseTo(
      xmC4Rate(sample(1, 1).relativeNote, sample(1, 1).finetune, true)!,
      3,
    );
  });

  it("creates the instrument when pasting into a slot that doesn't exist", () => {
    loadXmWavIntoCurrentSample(bytes(wav(100)), "a.wav");
    copyXmSampleRange(0, 40);
    setCurrentXmInstrument(5);
    setCurrentXmSampleIndex(0);
    pasteXmSampleBytes();
    expect(sample(5).data.length).toBe(40);
    expect(isXmInstrumentEmpty(inst(5))).toBe(false);
  });
});

describe("bounce", () => {
  it("is tuned so C-4 plays it back at the rate it was rendered at", () => {
    const s = emptyXmSong();
    const i = emptyXmInstrument();
    i.samples[0] = {
      ...i.samples[0]!,
      data: new Int8Array(64).fill(80),
      bits: 8,
      volume: 64,
    };
    s.instruments = [i];
    reset(setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 }));
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 7,
      startChannel: 0,
      endChannel: 0,
    });
    bounceXmSelectionToInstrument();
    const bounced = sample(2);
    expect(tuning(2)).toEqual(tuneForSampleRate(44100));
    // 8 rows at speed 6, 125 BPM = 48 ticks × 20 ms = 0.96 s. Read at
    // the rate its tuning gives, the bounce lasts exactly that long.
    const rate = xmC4Rate(bounced.relativeNote, bounced.finetune, true)!;
    expect(bounced.data.length / rate).toBeCloseTo(0.96, 3);
    expect(source(2)!.wav.sampleRate).toBe(Math.round(rate));
  });

  it("played back at C-4, the bounce lasts as long as the rows it was made from", () => {
    const s = emptyXmSong();
    const i = emptyXmInstrument();
    i.samples[0] = {
      ...i.samples[0]!,
      data: new Int8Array(64).fill(80),
      bits: 8,
      volume: 64,
      loopStart: 0,
      loopLength: 64,
      loopType: "forward",
    };
    s.instruments = [i];
    reset(setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 }));
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 7,
      startChannel: 0,
      endChannel: 0,
    });
    bounceXmSelectionToInstrument();
    // Play the bounced instrument alone and time it.
    let song = setXmCell(emptyXmSong(), 0, 0, 0, { note: 49, instrument: 1 });
    song = setXmInstrument(song, 0, inst(2));
    const SR = 44100;
    const r = new XmReplayer(
      { ...song, defaultTempo: 31, defaultBpm: 32 },
      {
        sampleRate: SR,
        loop: false,
        xmRamping: false,
        xmInterpolation: "none",
      },
    );
    const L = new Float32Array(SR * 2);
    r.process(L, new Float32Array(SR * 2), SR * 2);
    let last = -1;
    for (let n = 0; n < L.length; n++) if (L[n] !== 0) last = n;
    expect(Math.abs((last + 1) / SR - 0.96)).toBeLessThan(0.001);
  });
});
