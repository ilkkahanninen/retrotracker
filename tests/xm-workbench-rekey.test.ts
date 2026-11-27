/**
 * Regression: XM workbenches are keyed by `(instrument, sampleIdx)`. Ops
 * that replace / remove / copy sample bytes WITHOUT running the pipeline
 * used to leave the old workbench under the key, so the next chain edit
 * re-rendered the stale source over the new audio (silent data loss).
 *
 * Each test drives the stale-key scenario and then performs a pipeline
 * edit — the edit must operate on the audio the user actually sees.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeWav } from "../src/core/audio/wav";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import type { XmSample } from "../src/core/xm/types";
import {
  clearHistory,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
  xmWorkbenches,
} from "../src/state/xmSampleWorkbench";
import {
  addXmEffect,
  duplicateCurrentXmInstrument,
  duplicateCurrentXmSample,
  loadXmWavIntoCurrentSample,
  setXmBitDepth,
} from "../src/state/xmSampleEdit";
import { addXmSample, removeXmSample } from "../src/state/xmInstrumentEdit";
import {
  dropWavsToXmInstrumentView,
  loadWavsIntoXmSlot,
} from "../src/state/dropImport";

function wavBytes(frames: number): Uint8Array {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i / 32) * Math.PI) * 0.5;
  return writeWav({ sampleRate: 22050, channels: [ch] }, { bitsPerSample: 16 });
}

function wavFile(name: string, frames: number): File {
  return new File([wavBytes(frames) as unknown as BlobPart], name, {
    type: "audio/wav",
  });
}

function sampleAt(inst1Based: number, idx: number): XmSample | undefined {
  return xm2Song()?.instruments[inst1Based - 1]?.samples[idx];
}

function frames(inst1Based: number, idx: number): number {
  return sampleAt(inst1Based, idx)?.data.length ?? -1;
}

function sourceName(inst1Based: number, idx: number): string | undefined {
  const wb = getXmWorkbench(inst1Based, idx);
  return wb?.source.kind === "sampler" ? wb.source.sourceName : undefined;
}

function reset(): void {
  const s = emptyXmSong();
  s.instruments = [emptyXmInstrument()];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearHistory();
  clearAllXmWorkbenches();
}

beforeEach(reset);
afterEach(() => {
  setSong(null);
  clearHistory();
  clearAllXmWorkbenches();
  setTransport("idle");
});

describe("XM workbench keys follow the samples", () => {
  it("dropping a WAV onto an instrument row replaces its workbench", async () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "old.wav");
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBeDefined();

    await loadWavsIntoXmSlot(1, [wavFile("new.wav", 500)]);
    expect(frames(1, 0)).toBe(500);
    // The workbench that described old.wav must be gone — replaced by
    // one whose source is the dropped WAV.
    expect(sourceName(1, 0)).toBe("new");

    // A pipeline edit now works on new.wav, not the stale source.
    addXmEffect("normalize");
    expect(frames(1, 0)).toBe(500);
  });

  it("undoing the drop restores both the old bytes and the old workbench", async () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "old.wav");
    const before = getXmWorkbench(1, 0);
    await loadWavsIntoXmSlot(1, [wavFile("new.wav", 500)]);

    undo();
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBe(before);
  });

  it("removing a sample shifts later workbenches down", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");
    addXmSample(1);
    setCurrentXmSampleIndex(1);
    loadXmWavIntoCurrentSample(wavBytes(300), "B.wav");
    expect(sourceName(1, 0)).toBe("A");
    expect(sourceName(1, 1)).toBe("B");

    removeXmSample(1, 0);
    setCurrentXmSampleIndex(0);
    // Sample 0 is now B — and so is its workbench. No orphan at index 1.
    expect(frames(1, 0)).toBe(300);
    expect(sourceName(1, 0)).toBe("B");
    expect(getXmWorkbench(1, 1)).toBeUndefined();

    // The data-loss repro: a pipeline edit used to swap B's audio for A's.
    addXmEffect("normalize");
    expect(frames(1, 0)).toBe(300);
  });

  it("undoing a sample removal restores the original keys", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");
    addXmSample(1);
    setCurrentXmSampleIndex(1);
    loadXmWavIntoCurrentSample(wavBytes(300), "B.wav");

    removeXmSample(1, 0);
    undo();
    expect(frames(1, 0)).toBe(100);
    expect(frames(1, 1)).toBe(300);
    expect(sourceName(1, 0)).toBe("A");
    expect(sourceName(1, 1)).toBe("B");
  });

  it("a sample added after a removal does not inherit an orphan workbench", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");
    addXmSample(1);
    setCurrentXmSampleIndex(1);
    loadXmWavIntoCurrentSample(wavBytes(300), "B.wav");

    removeXmSample(1, 1);
    addXmSample(1);
    expect(frames(1, 1)).toBe(0);
    expect(getXmWorkbench(1, 1)).toBeUndefined();
  });

  it("duplicating an instrument onto a slot with a stale workbench keeps the copy", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");

    // Lazily create an empty-source workbench on the still-"free" slot 2.
    const s = xm2Song()!;
    setSong({ ...s, instruments: [...s.instruments, emptyXmInstrument()] });
    setCurrentXmInstrument(2);
    setXmBitDepth(16);
    expect(getXmWorkbench(2, 0)).toBeDefined();
    expect(frames(2, 0)).toBe(0);

    setCurrentXmInstrument(1);
    duplicateCurrentXmInstrument();
    expect(frames(2, 0)).toBe(100);
    // The copy carries the source's pipeline, not the stale empty one.
    expect(getXmWorkbench(2, 0)).toBe(getXmWorkbench(1, 0));

    // Used to wipe the copy to 0 frames.
    addXmEffect("normalize");
    expect(frames(2, 0)).toBe(100);
  });

  it("duplicating a sample copies its workbench to the new index", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");
    duplicateCurrentXmSample();
    expect(frames(1, 1)).toBe(100);
    expect(getXmWorkbench(1, 1)).toBe(getXmWorkbench(1, 0));
  });

  it("dropping WAVs onto an empty instrument clears its leftover workbenches", async () => {
    // Empty slot that still owns a workbench.
    setXmBitDepth(16);
    expect(getXmWorkbench(1, 0)).toBeDefined();
    expect(frames(1, 0)).toBe(0);

    await dropWavsToXmInstrumentView([wavFile("new.wav", 400)]);
    expect(frames(1, 0)).toBe(400);
    // The leftover is replaced by the dropped WAV's own workbench, with
    // the import's defaults rather than the leftover's settings.
    expect(sourceName(1, 0)).toBe("new");
    expect(getXmWorkbench(1, 0)!.chain).toEqual([]);

    addXmEffect("normalize");
    expect(frames(1, 0)).toBe(400);
  });

  it("a rejected removal leaves the workbench map untouched", () => {
    loadXmWavIntoCurrentSample(wavBytes(100), "A.wav");
    const before = xmWorkbenches();
    removeXmSample(1, 7); // out of range
    expect(xmWorkbenches()).toBe(before);
  });
});
