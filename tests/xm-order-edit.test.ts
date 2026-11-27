import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyXmPattern, emptyXmSong } from "~/core/xm/format";
import { cleanupXmOrders, setXmOrderPattern } from "~/core/xm/mutations";
import { resetXmCursor, setXmCursor, xmCursor } from "~/state/cursorXm";
import { patternNames, resetPatternNames } from "~/state/patternNames";
import {
  canUndo,
  clearHistory,
  commitEditXm,
  redo,
  setSong,
  setTransport,
  undo,
  xm2Song,
} from "~/state/song";
import {
  cleanupXmOrderList,
  deleteXmOrderSlot,
  duplicateXmCurrentPattern,
  insertXmOrderSlot,
  jumpXmNextOrder,
  jumpXmPrevOrder,
  newXmBlankPatternAtOrder,
  renameXmPattern,
  stepXmNextPattern,
  stepXmPrevPattern,
} from "~/state/xmOrderEdit";

function freshSong() {
  let song = emptyXmSong();
  song = { ...song, songLength: 3, orders: [...song.orders] };
  song.orders[0] = 0;
  song.orders[1] = 0;
  song.orders[2] = 0;
  setSong(song);
  resetXmCursor();
  resetPatternNames();
  setTransport("idle");
  clearHistory();
}

beforeEach(freshSong);
afterEach(() => {
  setSong(null);
  clearHistory();
});

describe("jump prev/next order", () => {
  it("jumpXmNextOrder moves the cursor forward, capped at songLength-1", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    jumpXmNextOrder();
    expect(xmCursor().order).toBe(1);
    jumpXmNextOrder();
    expect(xmCursor().order).toBe(2);
    jumpXmNextOrder(); // capped
    expect(xmCursor().order).toBe(2);
  });

  it("jumpXmPrevOrder moves backward, capped at 0", () => {
    setXmCursor({ order: 2, row: 5, channel: 1, field: "instHi" });
    jumpXmPrevOrder();
    expect(xmCursor().order).toBe(1);
    expect(xmCursor().row).toBe(0); // jump resets the row
    jumpXmPrevOrder();
    expect(xmCursor().order).toBe(0);
    jumpXmPrevOrder(); // capped
    expect(xmCursor().order).toBe(0);
  });
});

describe("step prev/next pattern at slot", () => {
  it("stepXmNextPattern grows the pattern array when the slot would wrap", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    stepXmNextPattern();
    expect(xm2Song()!.orders[0]).toBe(1);
    expect(xm2Song()!.patterns.length).toBe(2);
  });

  it("stepXmPrevPattern clamps at 0", () => {
    let s = xm2Song()!;
    s = setXmOrderPattern(s, 0, 2);
    setSong(s);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    stepXmPrevPattern();
    expect(xm2Song()!.orders[0]).toBe(1);
    stepXmPrevPattern();
    expect(xm2Song()!.orders[0]).toBe(0);
    stepXmPrevPattern(); // capped
    expect(xm2Song()!.orders[0]).toBe(0);
  });
});

describe("insert / delete order slot", () => {
  it("insertXmOrderSlot duplicates the cursor's pattern number and follows", () => {
    setXmCursor({ order: 1, row: 0, channel: 0, field: "note" });
    insertXmOrderSlot();
    expect(xm2Song()!.songLength).toBe(4);
    expect(xmCursor().order).toBe(2);
  });

  it("deleteXmOrderSlot pulls the cursor back when it falls off the tail", () => {
    setXmCursor({ order: 2, row: 0, channel: 0, field: "note" });
    deleteXmOrderSlot();
    expect(xm2Song()!.songLength).toBe(2);
    expect(xmCursor().order).toBe(1);
  });

  it("deleteXmOrderSlot keeps the song with at least one slot", () => {
    // Walk the song down to length 1.
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    deleteXmOrderSlot();
    deleteXmOrderSlot();
    deleteXmOrderSlot(); // refuse — already at length 1
    expect(xm2Song()!.songLength).toBe(1);
  });
});

describe("new / duplicate pattern at slot", () => {
  it("newXmBlankPatternAtOrder appends + points the slot", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    newXmBlankPatternAtOrder();
    const s = xm2Song()!;
    expect(s.patterns.length).toBe(2);
    expect(s.orders[0]).toBe(1);
  });

  it("duplicateXmCurrentPattern deep-clones the cursor's pattern", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    duplicateXmCurrentPattern();
    const s = xm2Song()!;
    expect(s.patterns.length).toBe(2);
    expect(s.orders[0]).toBe(1);
  });
});

describe("transport gating", () => {
  it("structural ops still go through commitEditXm — no-op while playing", () => {
    setTransport("playing");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    insertXmOrderSlot();
    expect(xm2Song()!.songLength).toBe(3);
  });
});

describe("cleanupXmOrders", () => {
  it("renumbers by first appearance, drops unused, keeps per-pattern row counts", () => {
    let s = emptyXmSong();
    s = {
      ...s,
      patterns: [16, 32, 48, 64].map((rows) =>
        emptyXmPattern(rows, s.channelCount),
      ),
      songLength: 4,
      orders: Object.assign(s.orders.slice(), [3, 1, 3, 0]),
      restartPosition: 2,
    };
    // A stale reference past songLength must not survive.
    s.orders[10] = 2;
    const { song: next, remap } = cleanupXmOrders(s);
    expect(next.patterns.map((p) => p.rowCount)).toEqual([64, 32, 16]);
    expect(next.orders.slice(0, 4)).toEqual([0, 1, 0, 2]);
    expect(next.orders[10]).toBe(0);
    expect(next.orders.length).toBe(s.orders.length);
    expect(remap).toEqual([2, 1, undefined, 0]);
    expect(next.restartPosition).toBe(2);
  });

  it("returns the same song when already tidy", () => {
    const s = emptyXmSong();
    expect(cleanupXmOrders(s).song).toBe(s);
  });
});

describe("renameXmPattern", () => {
  it("names a pattern, and undo / redo follow it", () => {
    renameXmPattern(0, "intro");
    expect(patternNames()[0]).toBe("intro");
    undo();
    expect(patternNames()[0]).toBeUndefined();
    redo();
    expect(patternNames()[0]).toBe("intro");
  });

  it("survives undoing a later song edit", () => {
    renameXmPattern(0, "intro");
    commitEditXm((s) => setXmOrderPattern(s, 1, 0));
    commitEditXm((s) => ({ ...s, title: "x" }));
    undo();
    expect(patternNames()[0]).toBe("intro");
  });

  it("a blank name clears the entry and a no-op records nothing", () => {
    renameXmPattern(0, "   ");
    expect(canUndo()).toBe(false);
    renameXmPattern(0, "intro");
    renameXmPattern(0, "intro");
    renameXmPattern(0, "");
    expect(patternNames()[0]).toBeUndefined();
    undo();
    expect(patternNames()[0]).toBe("intro");
    undo();
    expect(canUndo()).toBe(false);
  });

  it("works while playing", () => {
    setTransport("playing");
    renameXmPattern(0, "live");
    expect(patternNames()[0]).toBe("live");
  });
});

describe("cleanupXmOrderList", () => {
  function loadUntidy() {
    let s = emptyXmSong();
    s = {
      ...s,
      patterns: [16, 32, 48, 64].map((rows) =>
        emptyXmPattern(rows, s.channelCount),
      ),
      songLength: 4,
      orders: Object.assign(s.orders.slice(), [3, 1, 3, 0]),
    };
    setSong(s);
    clearHistory();
  }

  it("re-keys pattern names to the new numbering and drops unused ones", () => {
    loadUntidy();
    renameXmPattern(0, "outro");
    renameXmPattern(2, "unused");
    renameXmPattern(3, "intro");
    cleanupXmOrderList();
    // remap: 3 → 0, 1 → 1, 0 → 2, 2 dropped.
    expect(patternNames()).toEqual({ 0: "intro", 2: "outro" });
  });

  it("undo restores the song and its names together", () => {
    loadUntidy();
    renameXmPattern(3, "intro");
    cleanupXmOrderList();
    undo();
    expect(xm2Song()!.patterns).toHaveLength(4);
    expect(patternNames()).toEqual({ 3: "intro" });
  });
});
