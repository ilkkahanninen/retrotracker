/**
 * Verifies the XM live-preview swap: when a preview is in flight and
 * the user mutates the workbench (chiptune param, chain effect), the
 * engine is handed the new instrument (`swapXmPreviewInstrument`) so the
 * sounding voice morphs — it is not restarted.
 *
 * Mirrors PT2's `livePreviewSwap` test bed.
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
import type { XmInstrument, XmSong } from "../src/core/xm/types";

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
/** Everything that makes the preview worklet sound or change. */
const audible = () => [
  ...fake.callsTo("startXmPreview"),
  ...fake.callsTo("swapXmPreviewInstrument"),
];

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

  it("a key press starts one note, carrying only the auditioned instrument", async () => {
    await ensureEngine();
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    const calls = fake.callsTo("startXmPreview");
    expect(calls).toHaveLength(1);
    const song = calls[0]!.args[0] as XmSong;
    // The whole instrument list would be cloned to the audio thread on
    // every key press.
    expect(song.instruments).toHaveLength(1);
    expect(song.instruments[0]!.name).toBe("ins-a");
    expect(song.patterns[0]!.rows[0]![0]!.instrument).toBe(1);
  });

  it("editing a chiptune param while a preview is active swaps the instrument", async () => {
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    previewXmNote(0);
    // Yield to let the ensureEngine().then(...) microtask deliver the
    // startXmPreview call.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callsTo("startXmPreview")).toHaveLength(1);

    // User drags a chiptune slider mid-preview.
    updateXmChiptune({ cycleFrames: 128 });
    // The voice is handed the new instrument and keeps playing — no
    // second start, so no click and no restart-from-zero on slider drags.
    expect(fake.callsTo("startXmPreview")).toHaveLength(1);
    const swaps = fake.callsTo("swapXmPreviewInstrument");
    expect(swaps).toHaveLength(1);
    expect((swaps[0]!.args[0] as XmInstrument).samples[0]!.data).toBe(
      xm2Song()!.instruments[0]!.samples[0]!.data,
    );
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
    const playsBefore = audible().length;
    const stopsBefore = fake.callsTo("stopPreview").length;
    expect(activeXmPreview()).not.toBeNull();

    setXmSourceKind("chiptune");
    // No new start, no swap.
    expect(audible().length).toBe(playsBefore);
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

    const playsBefore = audible().length;
    updateXmChiptune({ cycleFrames: 128 });
    // The engine-gate kicked in: nothing new reaches the worklet.
    expect(audible().length).toBe(playsBefore);
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
    const playsBefore = audible().length;

    // Drag a slider — must not re-trigger the preview.
    updateXmChiptune({ cycleFrames: 128 });
    expect(audible().length).toBe(playsBefore);
  });

  it("clicking a source-kind tab with no active preview does NOT trigger audio", async () => {
    // Direct repro of the bug the user reported: open instrument view,
    // click Chiptune (no prior piano key), audio should stay silent.
    await ensureEngine();
    expect(activeXmPreview()).toBeNull();
    const before = audible().length;
    setXmSourceKind("chiptune");
    expect(audible().length).toBe(before);
  });

  it("adding a chain effect to a sampler while previewing swaps the instrument", async () => {
    await ensureEngine();
    // Sampler is the default for a loaded sample, no need to toggle.
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();

    addXmEffect("normalize");
    expect(fake.callsTo("swapXmPreviewInstrument")).toHaveLength(1);
    expect(fake.callsTo("startXmPreview")).toHaveLength(1);
  });

  it("workbench mutation with NO active preview does not call the engine", async () => {
    await ensureEngine();
    // No previewXmNote — activeXmPreview is null.
    expect(activeXmPreview()).toBeNull();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    updateXmChiptune({ cycleFrames: 128 });
    expect(audible()).toEqual([]);
  });

  it("calling the engine's onEnded clears the activeXmPreview signal", async () => {
    await ensureEngine();
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(activeXmPreview()).not.toBeNull();

    // The mock records the onEnded callback as the 3rd arg of
    // startXmPreview. Invoke it to simulate the note running out.
    const lastCall = fake.callsTo("startXmPreview").slice(-1)[0]!;
    const onEnded = lastCall.args[2] as (() => void) | undefined;
    onEnded?.();
    expect(activeXmPreview()).toBeNull();
  });

  it("works over a playing song: the preview has its own node, as PT's does", async () => {
    // Both the audition and the swap used to be refused whenever the
    // song played.
    await ensureEngine();
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    setTransport("playing");
    previewXmNote(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callsTo("startXmPreview")).toHaveLength(1);

    updateXmChiptune({ cycleFrames: 128 });
    expect(fake.callsTo("swapXmPreviewInstrument")).toHaveLength(1);
  });

  it("pinned to a sample, the preview and its swaps play that sample", async () => {
    // The instrument editor auditions the sample being edited; with the
    // default key map every key would play sample 0.
    const s = xm2Song()!;
    const second = {
      ...s.instruments[0]!.samples[0]!,
      data: new Int8Array(64).fill(50),
    };
    setSong({
      ...s,
      instruments: [
        {
          ...s.instruments[0]!,
          samples: [s.instruments[0]!.samples[0]!, second],
        },
      ],
    });
    setCurrentXmSampleIndex(1);
    await ensureEngine();
    previewXmNote(0, { sampleIdx: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(activeXmPreview()).toEqual({
      instrument1Based: 1,
      semitoneOffset: 0,
      sampleIdx: 1,
    });
    const song = fake.callsTo("startXmPreview")[0]!.args[0] as XmSong;
    expect(Array.from(new Set(song.instruments[0]!.keyMap))).toEqual([1]);

    addXmEffect("normalize");
    const swapped = fake.callsTo("swapXmPreviewInstrument")[0]!
      .args[0] as XmInstrument;
    expect(Array.from(new Set(swapped.keyMap))).toEqual([1]);
  });

  it("pinned to an empty sample, nothing plays (no fallback to another)", async () => {
    const s = xm2Song()!;
    setSong({
      ...s,
      instruments: [
        {
          ...s.instruments[0]!,
          samples: [
            s.instruments[0]!.samples[0]!,
            { ...s.instruments[0]!.samples[0]!, data: new Int8Array(0) },
          ],
        },
      ],
    });
    await ensureEngine();
    previewXmNote(0, { sampleIdx: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callsTo("startXmPreview")).toHaveLength(0);
    expect(activeXmPreview()).toBeNull();
  });
});
