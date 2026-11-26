import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  attachLateWorkbenches,
  canRedo,
  canUndo,
  clearHistory,
  commitEdit,
  commitEditWithWorkbenches,
  redo,
  setSong,
  setTransport,
  song,
  undo,
} from "../src/state/song";
import { emptySong } from "../src/core/mod/format";
import type { SampleWorkbench } from "../src/core/audio/sampleWorkbench";
import {
  clearAllWorkbenches,
  withWorkbench,
  workbenches,
} from "../src/state/sampleWorkbench";
import {
  loadPatternNames,
  patternNames,
  resetPatternNames,
} from "../src/state/patternNames";

function makeSong(title: string) {
  const s = emptySong();
  s.title = title;
  return s;
}

describe("song history", () => {
  beforeEach(() => {
    setSong(null);
    clearHistory();
  });
  afterEach(() => {
    setSong(null);
    clearHistory();
  });

  it("commits a new state and reports canUndo", () => {
    setSong(makeSong("A"));
    expect(canUndo()).toBe(false);

    commitEdit((s) => ({ ...s, title: "B" }));

    expect(song()!.title).toBe("B");
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it("undoes back to the prior snapshot", () => {
    setSong(makeSong("A"));
    commitEdit((s) => ({ ...s, title: "B" }));

    undo();

    expect(song()!.title).toBe("A");
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
  });

  it("redoes after an undo", () => {
    setSong(makeSong("A"));
    commitEdit((s) => ({ ...s, title: "B" }));
    undo();
    redo();

    expect(song()!.title).toBe("B");
    expect(canRedo()).toBe(false);
  });

  it("clears the redo stack on a fresh commit", () => {
    setSong(makeSong("A"));
    commitEdit((s) => ({ ...s, title: "B" }));
    undo();
    expect(canRedo()).toBe(true);

    commitEdit((s) => ({ ...s, title: "C" }));

    expect(canRedo()).toBe(false);
    expect(song()!.title).toBe("C");
  });

  it("skips no-op transforms that return the same reference", () => {
    setSong(makeSong("A"));
    commitEdit((s) => s);
    expect(canUndo()).toBe(false);
  });

  it("does nothing if no song is loaded", () => {
    commitEdit((s) => ({ ...s, title: "B" }));
    expect(song()).toBeNull();
    expect(canUndo()).toBe(false);
  });

  it("caps the history at HISTORY_LIMIT entries", () => {
    setSong(makeSong("start"));
    const overshoot = 50;
    for (let i = 0; i < HISTORY_LIMIT + overshoot; i++) {
      commitEdit((s) => ({ ...s, title: String(i) }));
    }
    let undos = 0;
    while (canUndo()) {
      undo();
      undos++;
      if (undos > HISTORY_LIMIT + overshoot + 5)
        throw new Error("runaway undo");
    }
    expect(undos).toBe(HISTORY_LIMIT);
  });

  it("clearHistory wipes both stacks", () => {
    setSong(makeSong("A"));
    commitEdit((s) => ({ ...s, title: "B" }));
    undo();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);

    clearHistory();

    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  describe("playback gate", () => {
    afterEach(() => setTransport("idle"));

    it("commitEdit is a no-op while playing", () => {
      setSong(makeSong("A"));
      setTransport("playing");
      commitEdit((s) => ({ ...s, title: "B" }));
      expect(song()!.title).toBe("A");
      expect(canUndo()).toBe(false);
    });

    it("undo is a no-op while playing", () => {
      setSong(makeSong("A"));
      commitEdit((s) => ({ ...s, title: "B" }));
      setTransport("playing");
      undo();
      expect(song()!.title).toBe("B");
      expect(canUndo()).toBe(true);
    });

    it("redo is a no-op while playing", () => {
      setSong(makeSong("A"));
      commitEdit((s) => ({ ...s, title: "B" }));
      undo();
      setTransport("playing");
      redo();
      expect(song()!.title).toBe("A");
      expect(canRedo()).toBe(true);
    });
  });

  // Pattern names live in their own signal but are bundled into each undo
  // snapshot so a Clean Up (which renumbers patterns) can revert atomically.
  // Without this, undo would leave names mapped to vanished pattern indices.
  describe("pattern-name bundling", () => {
    afterEach(() => resetPatternNames());

    it("undo restores the pattern-name map captured at commit time", () => {
      setSong(makeSong("A"));
      loadPatternNames({ 0: "intro" });
      // Commit a state that re-keys names alongside the song change.
      commitEditWithWorkbenches((state) => ({
        ...state,
        song: { ...state.song, title: "B" },
        patternNames: { 5: "renamed" },
      }));
      expect(patternNames()).toEqual({ 5: "renamed" });
      undo();
      expect(song()!.title).toBe("A");
      expect(patternNames()).toEqual({ 0: "intro" });
    });

    it("redo reapplies the bundled name map", () => {
      setSong(makeSong("A"));
      loadPatternNames({ 0: "intro" });
      commitEditWithWorkbenches((state) => ({
        ...state,
        song: { ...state.song, title: "B" },
        patternNames: { 5: "renamed" },
      }));
      undo();
      redo();
      expect(patternNames()).toEqual({ 5: "renamed" });
    });
  });
});

describe("attachLateWorkbenches", () => {
  const late = { source: { kind: "sampler" } } as unknown as SampleWorkbench;
  const attach = () =>
    attachLateWorkbenches(
      (map) => (map.has(1) ? map : withWorkbench(map, 1, late)),
      (map) => map,
    );

  beforeEach(() => {
    setSong(makeSong("A"));
    setTransport("idle");
    clearAllWorkbenches();
    clearHistory();
  });
  afterEach(() => {
    setSong(null);
    clearAllWorkbenches();
    clearHistory();
  });

  it("survives undo / redo of edits made before it arrived", () => {
    // Regression: restored sampler workbenches were set on the live map
    // only. Undoing an earlier edit brought back a snapshot without them,
    // and the next autosave swept their audio from the source store.
    commitEdit((s) => ({ ...s, title: "B" }));
    commitEdit((s) => ({ ...s, title: "C" }));
    undo(); // "C" now sits in the redo stack
    attach();
    expect(workbenches().get(1)).toBe(late);

    undo();
    expect(song()!.title).toBe("A");
    expect(workbenches().get(1)).toBe(late);
    redo();
    redo();
    expect(song()!.title).toBe("C");
    expect(workbenches().get(1)).toBe(late);
  });

  it("is not an edit: no undo entry, snapshots keep sharing one map", () => {
    attach();
    expect(canUndo()).toBe(false);
    commitEdit((s) => ({ ...s, title: "B" }));
    const live = workbenches();
    undo();
    expect(workbenches()).toBe(live);
  });

  it("leaves a slot the user already filled alone", () => {
    const mine = { source: { kind: "chiptune" } } as unknown as SampleWorkbench;
    commitEditWithWorkbenches((state) => ({
      ...state,
      workbenches: withWorkbench(state.workbenches, 1, mine),
    }));
    attach();
    expect(workbenches().get(1)).toBe(mine);
    undo(); // the pre-edit snapshot had no workbench — it gets the late one
    expect(workbenches().get(1)).toBe(late);
  });
});
