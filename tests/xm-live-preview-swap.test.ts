/**
 * Verifies the XM live-preview swap: when a preview is in flight and
 * the user mutates the workbench (chiptune param, chain effect), the
 * engine receives a fresh `playXmPreviewBuffer` call so the audible
 * voice reflects the edit.
 *
 * Mirrors PT2's `livePreviewSwap` test bed but for the XM
 * AudioBufferSourceNode path (vs. PT2's gapless Paula morph).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setSong,
  setTransport,
  clearHistory,
  xm2Song,
} from "../src/state/song";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import {
  clearAllXmWorkbenches,
  setXmWorkbench,
} from "../src/state/xmSampleWorkbench";
import {
  activeXmPreview,
  clearActiveXmPreview,
  previewXmNote,
} from "../src/state/xmPreview";
import {
  addXmEffect,
  setXmSourceKind,
  updateXmChiptune,
} from "../src/state/xmSampleEdit";
import { ensureEngine, disposeEngine } from "../src/state/playback";
import {
  installRecordingEngine,
  type RecordingEngine,
} from "./lib/recording-engine";
import { xmWorkbenchFromChiptune } from "../src/core/audio/sampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.data = new Int8Array(200).map((_, i) => (i % 32) - 16);
  inst.samples[0]!.bits = 8;
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearAllXmWorkbenches();
  clearActiveXmPreview();
  clearHistory();
}

let fake: RecordingEngine;

beforeEach(() => {
  seed();
  fake = installRecordingEngine();
});

afterEach(async () => {
  await disposeEngine();
  vi.restoreAllMocks();
  setSong(null);
  clearHistory();
  clearAllXmWorkbenches();
  setTransport("idle");
});

describe("XM live preview swap", () => {
  it("starts tracking an active preview when previewXmNote fires", async () => {
    await ensureEngine();
    previewXmNote(0);
    // The semitone offset and the current instrument are recorded so a
    // subsequent workbench mutation knows what to re-render.
    expect(activeXmPreview()).toEqual({
      instrument1Based: 1,
      semitoneOffset: 0,
    });
  });

  it("previews the same XM note the pattern editor writes (octave × 12 + offset + 1)", async () => {
    // Regression: the two used to disagree by 12 semitones — pattern
    // editor's note 49 (C-4) but preview triggered note 37 (C-3) for
    // the same key press, so the audible preview was an octave below
    // what the song played back.
    const { enterXmNote } = await import("../src/state/xmPatternEdit");
    const { setCurrentXmOctave } = await import("../src/state/xmEdit");
    const { setXmCursor } = await import("../src/state/cursorXm");
    const { xmNoteForPreviewOffset } = await import("../src/state/xmPreview");

    setCurrentXmOctave(4);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    enterXmNote(0); // C on octave 4 → cell note 49 (C-4).
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(49);
    expect(xmNoteForPreviewOffset(0)).toBe(49);

    // Octave change moves both together.
    setCurrentXmOctave(5);
    expect(xmNoteForPreviewOffset(0)).toBe(61); // C-5

    // Sweep all 12 piano keys at octave 3 — every offset must agree.
    setCurrentXmOctave(3);
    for (let offset = 0; offset < 12; offset++) {
      setXmCursor({ order: 0, row: offset, channel: 0, field: "note" });
      enterXmNote(offset);
      const cellNote = xm2Song()!.patterns[0]!.rows[offset]![0]!.note;
      expect(xmNoteForPreviewOffset(offset)).toBe(cellNote);
    }
  });

  it("editing a chiptune param while a preview is active replays the buffer", async () => {
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    // Trigger the preview so the AudioBufferSource is live.
    previewXmNote(0);
    // Yield to let the ensureEngine().then(...) microtask deliver the
    // first playXmPreviewBuffer call.
    await Promise.resolve();
    await Promise.resolve();
    const before = fake.callsTo("playXmPreviewBuffer").length;
    expect(before).toBeGreaterThan(0);
    // Trigger pushes restart=true (fresh note).
    expect(fake.callsTo("playXmPreviewBuffer")[0]!.args[4]).toBe(true);

    // User drags a chiptune slider mid-preview.
    updateXmChiptune({ cycleFrames: 128 });
    const calls = fake.callsTo("playXmPreviewBuffer");
    expect(calls.length).toBe(before + 1);
    // Swap pushes restart=false so the worklet keeps the read pointer
    // — no click, no restart-from-zero on slider drags.
    expect(calls[calls.length - 1]!.args[4]).toBe(false);
  });

  it("flipping source kind stops the preview instead of re-rendering it", async () => {
    // Regression: previously the source-kind toggle re-rendered the
    // preview against the new half, which sounded like an unrequested
    // fresh trigger (the slot's audible content had just changed
    // wholesale). The fix: stop the preview on a source-kind flip;
    // the user can re-strike a piano key to hear the new sound.
    await ensureEngine();
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    const playsBefore = fake.callsTo("playXmPreviewBuffer").length;
    const stopsBefore = fake.callsTo("stopPreview").length;
    expect(activeXmPreview()).not.toBeNull();

    setXmSourceKind("chiptune");
    // No new play call.
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(playsBefore);
    // The engine got a stop.
    expect(fake.callsTo("stopPreview").length).toBe(stopsBefore + 1);
    // And the active-preview signal is cleared.
    expect(activeXmPreview()).toBeNull();
  });

  it("slider drag after engine.stopPreview is silent even if activeXmPreview lingered briefly", async () => {
    // Defensive test for the race the user reported: key-up calls
    // engine.stopPreview (which clears the engine's xmPreviewOnEnded)
    // BUT some external state momentarily leaves `activeXmPreview`
    // set. The swap must consult the engine, not just the UI signal.
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(activeXmPreview()).not.toBeNull();
    expect(fake.isXmPreviewActive()).toBe(true);

    // Simulate ONLY the engine half of the key-up: the engine's
    // preview is no longer audible, but `activeXmPreview` is still
    // non-null (representing a stale UI-side signal).
    fake.stopPreview();
    expect(fake.isXmPreviewActive()).toBe(false);
    // activeXmPreview is still set — this is the stale state we
    // need the engine-gate to catch.
    expect(activeXmPreview()).not.toBeNull();

    const playsBefore = fake.callsTo("playXmPreviewBuffer").length;
    updateXmChiptune({ cycleFrames: 128 });
    // The engine-gate kicked in: no new play.
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(playsBefore);
    // And the stale signal got cleaned up as a side effect.
    expect(activeXmPreview()).toBeNull();
  });

  it("slider drags AFTER the user releases the piano key stay silent", async () => {
    // Direct repro: hold piano (preview plays), release piano (preview
    // stops), then drag a slider — no audio should fire.
    const { stopXmPreview } = await import("../src/state/xmPreview");
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(activeXmPreview()).not.toBeNull();

    // Simulate key-up.
    stopXmPreview();
    expect(activeXmPreview()).toBeNull();
    const playsBefore = fake.callsTo("playXmPreviewBuffer").length;

    // Drag a slider — must not re-trigger the preview.
    updateXmChiptune({ cycleFrames: 128 });
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(playsBefore);
  });

  it("clicking a source-kind tab with no active preview does NOT trigger audio", async () => {
    // Direct repro of the bug the user reported: open instrument view,
    // click Chiptune (no prior piano key), audio should stay silent.
    await ensureEngine();
    expect(activeXmPreview()).toBeNull();
    const before = fake.callsTo("playXmPreviewBuffer").length;
    setXmSourceKind("chiptune");
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(before);
  });

  it("adding a chain effect to a sampler while previewing replays the buffer", async () => {
    await ensureEngine();
    // Sampler is the default for a loaded sample, no need to toggle.
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    const before = fake.callsTo("playXmPreviewBuffer").length;

    addXmEffect("normalize");
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(before + 1);
  });

  it("workbench mutation with NO active preview does not call the engine", async () => {
    await ensureEngine();
    // No previewXmNote — activeXmPreview is null.
    expect(activeXmPreview()).toBeNull();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    updateXmChiptune({ cycleFrames: 128 });
    expect(fake.callsTo("playXmPreviewBuffer")).toEqual([]);
  });

  it("calling the engine's onEnded clears the activeXmPreview signal", async () => {
    await ensureEngine();
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(activeXmPreview()).not.toBeNull();

    // The mock records the onEnded callback as the 4th arg of
    // playXmPreviewBuffer. Invoke it to simulate the buffer ending.
    const lastCall = fake.callsTo("playXmPreviewBuffer").slice(-1)[0]!;
    const onEnded = lastCall.args[3] as (() => void) | undefined;
    onEnded?.();
    expect(activeXmPreview()).toBeNull();
  });

  it("song-playback transport blocks the swap (no spurious re-render)", async () => {
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    const before = fake.callsTo("playXmPreviewBuffer").length;

    setTransport("playing");
    updateXmChiptune({ cycleFrames: 128 });
    // updateCurrentXmWorkbench bails on transport===playing, so the
    // workbench doesn't commit AND no preview swap fires.
    expect(fake.callsTo("playXmPreviewBuffer").length).toBe(before);
    expect(xm2Song()).toBeDefined();
  });
});
