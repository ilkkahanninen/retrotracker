/**
 * Regression: XM sample-view actions (Load WAV, Clear sample, Clear
 * instrument, Duplicate instrument) committed the SONG through
 * `commitEditXm` — which no-ops while playing with Follow on — and then
 * unconditionally mutated the workbench map / UI signals. Under Play +
 * Follow that dropped workbenches and moved the UI while the song stayed
 * put. Both halves now move (or don't) together, in one undo entry.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeWav } from "../src/core/audio/wav";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import { setFollowPlayback } from "../src/state/settings";
import {
  canUndo,
  clearHistory,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "../src/state/song";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import {
  addXmEffect,
  clearCurrentXmInstrument,
  clearCurrentXmSample,
  duplicateCurrentXmInstrument,
  loadXmWavIntoCurrentSample,
} from "../src/state/xmSampleEdit";
import { addXmSample } from "../src/state/xmInstrumentEdit";
import {
  setXmSampleSelection,
  xmSampleSelection,
} from "../src/state/xmSampleSelection";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
  xmWorkbenches,
} from "../src/state/xmSampleWorkbench";

function wavBytes(frames: number): Uint8Array {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i / 32) * Math.PI) * 0.5;
  return writeWav({ sampleRate: 22050, channels: [ch] }, { bitsPerSample: 16 });
}
const frames = (inst: number, idx: number) =>
  xm2Song()?.instruments[inst - 1]?.samples[idx]?.data.length ?? -1;

function reset() {
  const s = emptyXmSong();
  s.instruments = [emptyXmInstrument()];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  setFollowPlayback(true);
  clearHistory();
  clearAllXmWorkbenches();
  setXmSampleSelection(null);
}
beforeEach(() => {
  reset();
  // Instrument 1: a WAV with one chain effect, plus a second sample.
  loadXmWavIntoCurrentSample(wavBytes(100), "old.wav");
  addXmEffect("normalize");
  addXmSample(1);
});
afterEach(() => {
  reset();
  setSong(null);
});

describe("while playing with Follow on, gated actions change nothing", () => {
  beforeEach(() => setTransport("playing"));

  it("Load WAV keeps the song AND the workbench (with its chain)", () => {
    const wbBefore = getXmWorkbench(1, 0);
    const songBefore = xm2Song();
    loadXmWavIntoCurrentSample(wavBytes(500), "new.wav");
    expect(xm2Song()).toBe(songBefore);
    expect(getXmWorkbench(1, 0)).toBe(wbBefore);
    expect(getXmWorkbench(1, 0)!.chain).toHaveLength(1);
  });

  it("Clear instrument keeps workbenches, sample index and selection", () => {
    setCurrentXmSampleIndex(1);
    setXmSampleSelection({ start: 1, end: 5 });
    const mapBefore = xmWorkbenches();
    clearCurrentXmInstrument();
    expect(frames(1, 0)).toBe(100);
    expect(xmWorkbenches()).toBe(mapBefore);
    expect(currentXmSampleIndex()).toBe(1);
    expect(xmSampleSelection()).toEqual({ start: 1, end: 5 });
  });

  it("Clear sample keeps the workbench", () => {
    const mapBefore = xmWorkbenches();
    clearCurrentXmSample();
    expect(frames(1, 0)).toBe(100);
    expect(xmWorkbenches()).toBe(mapBefore);
  });

  it("Duplicate instrument does not jump to the empty target slot", () => {
    duplicateCurrentXmInstrument();
    expect(currentXmInstrument()).toBe(1);
    expect(xm2Song()!.instruments).toHaveLength(1);
  });
});

describe("when allowed, song and workbench move in one undo entry", () => {
  it("undoing Load WAV restores the old bytes and the old chain together", () => {
    const wbBefore = getXmWorkbench(1, 0);
    loadXmWavIntoCurrentSample(wavBytes(500), "new.wav");
    expect(frames(1, 0)).toBe(500);
    expect(getXmWorkbench(1, 0)!.chain).toHaveLength(0);
    undo();
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBe(wbBefore);
  });

  it("undoing Clear instrument restores its workbenches", () => {
    const wbBefore = getXmWorkbench(1, 0);
    clearCurrentXmInstrument();
    expect(getXmWorkbench(1, 0)).toBeUndefined();
    undo();
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBe(wbBefore);
  });

  it("Clear sample drops the workbench, and undo brings both back", () => {
    const wbBefore = getXmWorkbench(1, 0);
    clearCurrentXmSample();
    expect(frames(1, 0)).toBe(0);
    expect(getXmWorkbench(1, 0)).toBeUndefined();
    undo();
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBe(wbBefore);
  });

  it("clearing an already-empty sample still drops a leftover workbench", () => {
    clearCurrentXmSample();
    // Re-attach a workbench to the now-empty slot (lazy init via an edit).
    addXmEffect("normalize");
    expect(getXmWorkbench(1, 0)).toBeDefined();
    clearCurrentXmSample();
    expect(getXmWorkbench(1, 0)).toBeUndefined();
    expect(canUndo()).toBe(true);
  });
});
