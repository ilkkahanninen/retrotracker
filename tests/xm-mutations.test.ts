import { describe, expect, it } from "vitest";

import { emptyXmPattern, emptyXmSong } from "~/core/xm/format";
import {
  deleteXmOrder,
  duplicateXmPatternAtOrder,
  insertXmOrder,
  insertXmOrderAtCursor,
  newXmPatternAtOrder,
  nextXmPatternAtOrder,
  prevXmPatternAtOrder,
  renameXmInstrument,
  setXmCell,
  setXmChannelCount,
  setXmOrderPattern,
  setXmPatternRowCount,
} from "~/core/xm/mutations";
import type { XmSong } from "~/core/xm/types";

function fresh(overrides: Partial<XmSong> = {}): XmSong {
  return { ...emptyXmSong(), ...overrides };
}

describe("setXmCell", () => {
  it("writes a cell at (order, row, channel)", () => {
    const next = setXmCell(fresh(), 0, 5, 2, {
      note: 49,
      instrument: 1,
      effect: 0x0c,
      effectParam: 0x40,
    });
    const cell = next.patterns[0]!.rows[5]![2]!;
    expect(cell.note).toBe(49);
    expect(cell.instrument).toBe(1);
    expect(cell.effect).toBe(0x0c);
    expect(cell.effectParam).toBe(0x40);
  });

  it("returns the same reference when nothing changes", () => {
    const before = fresh();
    const after = setXmCell(before, 0, 0, 0, { note: 0 });
    expect(after).toBe(before);
  });

  it("rejects out-of-range coordinates without throwing", () => {
    const before = fresh();
    expect(setXmCell(before, 99, 0, 0, { note: 1 })).toBe(before);
    expect(setXmCell(before, 0, 999, 0, { note: 1 })).toBe(before);
    expect(setXmCell(before, 0, 0, 50, { note: 1 })).toBe(before);
  });

  it("does not mutate the source song", () => {
    const before = fresh();
    setXmCell(before, 0, 0, 0, { note: 49 });
    expect(before.patterns[0]!.rows[0]![0]!.note).toBe(0);
  });
});

describe("setXmPatternRowCount", () => {
  it("grows a pattern with empty rows", () => {
    const next = setXmPatternRowCount(fresh(), 0, 96);
    expect(next.patterns[0]!.rowCount).toBe(96);
    expect(next.patterns[0]!.rows).toHaveLength(96);
    // Original 64 rows preserved; new rows are blank.
    expect(next.patterns[0]!.rows[80]!.every((c) => c.note === 0)).toBe(true);
  });

  it("trims a pattern's tail when shrinking", () => {
    const before = setXmCell(fresh(), 0, 50, 0, { note: 49 });
    const next = setXmPatternRowCount(before, 0, 32);
    expect(next.patterns[0]!.rowCount).toBe(32);
    expect(next.patterns[0]!.rows).toHaveLength(32);
  });

  it("rejects rowCount outside 1..256", () => {
    const before = fresh();
    expect(setXmPatternRowCount(before, 0, 0)).toBe(before);
    expect(setXmPatternRowCount(before, 0, 300)).toBe(before);
  });

  it("returns the same reference when rowCount unchanged", () => {
    const before = fresh();
    expect(setXmPatternRowCount(before, 0, before.patterns[0]!.rowCount)).toBe(
      before,
    );
  });
});

describe("setXmChannelCount", () => {
  it("widens patterns when growing channels", () => {
    const before = fresh({ channelCount: 4 });
    before.patterns = [emptyXmPattern(64, 4)];
    const next = setXmChannelCount(before, 8);
    expect(next.channelCount).toBe(8);
    expect(next.patterns[0]!.rows[0]).toHaveLength(8);
  });

  it("trims patterns when shrinking channels", () => {
    const before = fresh({ channelCount: 8 });
    before.patterns = [emptyXmPattern(64, 8)];
    const next = setXmChannelCount(before, 4);
    expect(next.channelCount).toBe(4);
    expect(next.patterns[0]!.rows[0]).toHaveLength(4);
  });

  it("rejects out-of-bounds counts", () => {
    const before = fresh();
    expect(setXmChannelCount(before, 1)).toBe(before);
    expect(setXmChannelCount(before, 33)).toBe(before);
  });
});

describe("XM order list ops", () => {
  it("insertXmOrder pushes existing entries forward", () => {
    const before = fresh({ songLength: 2 });
    before.orders[0] = 5;
    before.orders[1] = 6;
    const next = insertXmOrder(before, 1, 9);
    expect(next.songLength).toBe(3);
    expect(next.orders[0]).toBe(5);
    expect(next.orders[1]).toBe(9);
    expect(next.orders[2]).toBe(6);
  });

  it("deleteXmOrder pulls subsequent entries back", () => {
    const before = fresh({ songLength: 3 });
    before.orders[0] = 5;
    before.orders[1] = 9;
    before.orders[2] = 6;
    const next = deleteXmOrder(before, 1);
    expect(next.songLength).toBe(2);
    expect(next.orders[0]).toBe(5);
    expect(next.orders[1]).toBe(6);
  });

  it("deleteXmOrder refuses to leave the song with zero orders", () => {
    const before = fresh({ songLength: 1 });
    expect(deleteXmOrder(before, 0)).toBe(before);
  });

  it("setXmOrderPattern grows the pattern array if needed", () => {
    const before = fresh();
    expect(before.patterns).toHaveLength(1);
    const next = setXmOrderPattern(before, 0, 4);
    expect(next.patterns).toHaveLength(5);
    expect(next.orders[0]).toBe(4);
  });
});

describe("renameXmInstrument", () => {
  it("creates a stand-in instrument when the slot is past array length", () => {
    const before = fresh();
    expect(before.instruments).toHaveLength(0);
    const next = renameXmInstrument(before, 1, "kick");
    expect(next.instruments[0]?.name).toBe("kick");
  });

  it("preserves other fields when renaming an existing instrument", () => {
    const before = fresh();
    const filled = renameXmInstrument(before, 1, "lead");
    const filled2 = renameXmInstrument(filled, 1, "lead-renamed");
    expect(filled2.instruments[0]?.name).toBe("lead-renamed");
    // Identity check: shape unchanged apart from the name.
    expect(filled2.instruments[0]?.fadeout).toBe(
      filled.instruments[0]?.fadeout,
    );
  });

  it("trims to 22 chars (XM instrument-name field)", () => {
    const long = "x".repeat(40);
    const next = renameXmInstrument(fresh(), 1, long);
    expect(next.instruments[0]?.name.length).toBe(22);
  });

  it("returns the same reference when the name is unchanged", () => {
    const before = renameXmInstrument(fresh(), 1, "snare");
    const after = renameXmInstrument(before, 1, "snare");
    expect(after).toBe(before);
  });

  it("rejects out-of-range slots", () => {
    const before = fresh();
    expect(renameXmInstrument(before, 0, "x")).toBe(before);
    expect(renameXmInstrument(before, 129, "x")).toBe(before);
  });
});

describe("XM pattern stepping at order", () => {
  it("nextXmPatternAtOrder bumps the slot and grows the patterns array on overflow", () => {
    const before = fresh();
    expect(before.patterns).toHaveLength(1);
    const next = nextXmPatternAtOrder(before, 0);
    expect(next.orders[0]).toBe(1);
    expect(next.patterns).toHaveLength(2);
  });

  it("nextXmPatternAtOrder reuses an existing pattern when within range", () => {
    let song = fresh();
    song = setXmOrderPattern(song, 0, 0);
    // Grow the bank without using the slot.
    song = { ...song, patterns: [song.patterns[0]!, emptyXmPattern(64, 8)] };
    const after = nextXmPatternAtOrder(song, 0);
    expect(after.orders[0]).toBe(1);
    expect(after.patterns).toHaveLength(2);
  });

  it("prevXmPatternAtOrder steps down, clamped at 0", () => {
    let song = fresh();
    song = setXmOrderPattern(song, 0, 3);
    const after = prevXmPatternAtOrder(song, 0);
    expect(after.orders[0]).toBe(2);
    const atZero = prevXmPatternAtOrder(after, 0);
    // From 2 → 1 → ... eventually 0; once at 0, no more.
    let s = atZero;
    while ((s.orders[0] ?? 0) > 0) s = prevXmPatternAtOrder(s, 0);
    expect(prevXmPatternAtOrder(s, 0)).toBe(s);
  });

  it("newXmPatternAtOrder appends a fresh pattern and points at it", () => {
    const before = fresh();
    const next = newXmPatternAtOrder(before, 0);
    expect(next.patterns).toHaveLength(2);
    expect(next.orders[0]).toBe(1);
  });

  it("duplicateXmPatternAtOrder deep-clones the pattern (independent edits)", () => {
    let before = fresh();
    before = setXmCell(before, 0, 0, 0, { note: 49 });
    const after = duplicateXmPatternAtOrder(before, 0);
    expect(after.patterns).toHaveLength(2);
    // Clone is its own pattern: editing it doesn't reach back to the original.
    const edited = setXmCell(after, 0, 1, 0, { note: 50 });
    // The original's pattern 0 is untouched (new cell only on pattern 1).
    expect(edited.patterns[0]!.rows[1]![0]!.note).toBe(0);
  });

  it("insertXmOrderAtCursor duplicates the cursor's pattern number", () => {
    let song = fresh();
    song = setXmOrderPattern(song, 0, 3);
    const next = insertXmOrderAtCursor(song, 0);
    expect(next.songLength).toBe(2);
    expect(next.orders[0]).toBe(3);
    expect(next.orders[1]).toBe(3);
  });
});

describe("insertXmOrder (low-level)", () => {
  it("inserts a slot at the given index with the given pattern number", () => {
    const before = fresh();
    const next = insertXmOrder(before, 0, 5);
    expect(next.songLength).toBe(2);
    expect(next.orders[0]).toBe(5);
  });
});
