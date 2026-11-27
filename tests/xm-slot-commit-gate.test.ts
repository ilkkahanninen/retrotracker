/**
 * XM sample-view actions (Load WAV, Clear sample, Clear instrument,
 * Duplicate instrument) move the song and the workbench map together,
 * in one undo entry.
 *
 * History: they once committed the SONG through `commitEditXm` — which
 * no-ops while playing with Follow on — and then unconditionally mutated
 * the workbench map / UI signals, so under Play + Follow workbenches
 * were dropped while the song stayed put. The fix made both halves
 * gated; the gate itself is gone now (PT never had it, and sync.ts
 * forwards the result to the worklet), but the "both or neither"
 * invariant is what these tests keep.
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

describe("while playing with Follow on, the actions still apply — both halves", () => {
  beforeEach(() => setTransport("playing"));

  it("Load WAV replaces the bytes and the workbench in one undo entry", () => {
    const wbBefore = getXmWorkbench(1, 0);
    loadXmWavIntoCurrentSample(wavBytes(500), "new.wav");
    expect(frames(1, 0)).toBe(500);
    expect(getXmWorkbench(1, 0)).not.toBe(wbBefore);
    expect(getXmWorkbench(1, 0)!.chain).toHaveLength(0);
    // Undo is itself locked while Follow is on, as in PT mode.
    setTransport("idle");
    undo();
    expect(frames(1, 0)).toBe(100);
    expect(getXmWorkbench(1, 0)).toBe(wbBefore);
  });

  it("Clear instrument drops its workbenches and resets the sample index", () => {
    setCurrentXmSampleIndex(1);
    setXmSampleSelection({ start: 1, end: 5 });
    clearCurrentXmInstrument();
    expect(frames(1, 0)).toBe(0);
    expect(getXmWorkbench(1, 0)).toBeUndefined();
    expect(currentXmSampleIndex()).toBe(0);
    expect(xmSampleSelection()).toBeNull();
  });

  it("Clear sample empties the sample and drops its workbench", () => {
    clearCurrentXmSample();
    expect(frames(1, 0)).toBe(0);
    expect(getXmWorkbench(1, 0)).toBeUndefined();
  });

  it("Duplicate instrument fills the next slot and selects it", () => {
    duplicateCurrentXmInstrument();
    expect(currentXmInstrument()).toBe(2);
    expect(frames(2, 0)).toBe(100);
  });
});

describe("when stopped, song and workbench move in one undo entry", () => {
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
