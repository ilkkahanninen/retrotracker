import { describe, expect, it } from "vitest";

import { emptyPattern, emptySong } from "~/core/mod/format";
import {
  deleteOrderRange,
  duplicatePatternsInRange,
  repeatOrderRange,
  setCell,
} from "~/core/mod/mutations";
import { MAX_ORDERS, type ModSong } from "~/core/mod/types";
import { emptyXmPattern, emptyXmSong } from "~/core/xm/format";
import {
  deleteXmOrderRange,
  duplicateXmPatternsInRange,
  repeatXmOrderRange,
  setXmCell,
} from "~/core/xm/mutations";
import { XM_MAX_ORDERS, type XmSong } from "~/core/xm/types";

/**
 * Range versions of the order-list mutations, behind the order list's
 * multi-selection: repeat a run of slots, give a run its own pattern
 * copies, delete a run. One implementation (`makeOrderOps`) serves both
 * formats, so the behaviour is checked on PT and spot-checked on FT2.
 */

/** PT song over `numPatterns` patterns playing `orders`. */
function ptSong(orders: number[], numPatterns: number): ModSong {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = orders.length;
  orders.forEach((p, i) => (s.orders[i] = p));
  return s;
}
const live = (s: { orders: number[]; songLength: number }) =>
  s.orders.slice(0, s.songLength);

describe("repeatOrderRange", () => {
  it("inserts a copy of the run right after it, same pattern numbers", () => {
    const next = repeatOrderRange(ptSong([0, 1, 2, 3], 4), 1, 2);
    expect(live(next)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(next.patterns).toHaveLength(4);
  });

  it("repeats a single slot and a run at the end of the song", () => {
    expect(live(repeatOrderRange(ptSong([0, 1, 2], 3), 1, 1))).toEqual([
      0, 1, 1, 2,
    ]);
    expect(live(repeatOrderRange(ptSong([0, 1, 2], 3), 1, 2))).toEqual([
      0, 1, 2, 1, 2,
    ]);
  });

  it("takes the range in either direction and clamps it to the song", () => {
    expect(live(repeatOrderRange(ptSong([0, 1, 2, 3], 4), 2, 1))).toEqual([
      0, 1, 2, 1, 2, 3,
    ]);
    expect(live(repeatOrderRange(ptSong([0, 1], 2), 1, 99))).toEqual([0, 1, 1]);
  });

  it("is all or nothing at the order cap", () => {
    const full = ptSong(
      Array.from({ length: MAX_ORDERS - 1 }, () => 0),
      1,
    );
    // Room for exactly one more slot: a two-slot repeat is refused whole.
    expect(repeatOrderRange(full, 0, 1)).toBe(full);
    expect(repeatOrderRange(full, 0, 0).songLength).toBe(MAX_ORDERS);
  });

  it("keeps the orders array at its fixed length", () => {
    const s = ptSong([0, 1, 2, 3], 4);
    expect(repeatOrderRange(s, 0, 3).orders).toHaveLength(s.orders.length);
  });

  it("returns the same song for a range outside it", () => {
    const s = ptSong([0, 1], 2);
    expect(repeatOrderRange(s, 5, 9)).toBe(s);
  });
});

describe("duplicatePatternsInRange", () => {
  it("points the run at fresh copies and leaves the rest of the song alone", () => {
    const s = ptSong([0, 1, 2, 1, 2, 3], 4);
    const next = duplicatePatternsInRange(s, 3, 4);
    expect(live(next)).toEqual([0, 1, 2, 4, 5, 3]);
    expect(next.patterns).toHaveLength(6);
  });

  it("the copies hold the same notes but are separate patterns", () => {
    let s = ptSong([0, 1], 2);
    s = setCell(s, 1, 5, 0, { period: 428, sample: 1 });
    const next = duplicatePatternsInRange(s, 1, 1);
    const copy = next.patterns[next.orders[1]!]!;
    expect(copy.rows[5]![0]!.period).toBe(428);
    // Editing the copy leaves the original as it was.
    const edited = setCell(next, 1, 5, 0, { period: 214 });
    expect(edited.patterns[1]!.rows[5]![0]!.period).toBe(428);
    expect(edited.patterns[2]!.rows[5]![0]!.period).toBe(214);
  });

  it("clones each distinct pattern once: slots that shared one share the copy", () => {
    const next = duplicatePatternsInRange(ptSong([0, 1, 0, 1, 2], 3), 0, 3);
    expect(live(next)).toEqual([3, 4, 3, 4, 2]);
    expect(next.patterns).toHaveLength(5);
  });

  it("returns the same song for a range outside it", () => {
    const s = ptSong([0, 1], 2);
    expect(duplicatePatternsInRange(s, 4, 6)).toBe(s);
  });
});

describe("deleteOrderRange", () => {
  it("removes the run and pulls the rest left", () => {
    const next = deleteOrderRange(ptSong([0, 1, 2, 3, 4], 5), 1, 3);
    expect(live(next)).toEqual([0, 4]);
    // Freed slots are zeroed, and the array keeps its fixed length.
    expect(next.orders.slice(2).every((p) => p === 0)).toBe(true);
    expect(next.orders).toHaveLength(MAX_ORDERS);
  });

  it("always leaves one slot: deleting the whole song keeps its first", () => {
    const next = deleteOrderRange(ptSong([3, 1, 2], 4), 0, 2);
    expect(live(next)).toEqual([3]);
  });

  it("a one-slot song can't be emptied", () => {
    const s = ptSong([2], 3);
    expect(deleteOrderRange(s, 0, 0)).toBe(s);
  });

  it("deletes a run at the end", () => {
    expect(live(deleteOrderRange(ptSong([0, 1, 2, 3], 4), 2, 3))).toEqual([
      0, 1,
    ]);
  });
});

describe("the same operations on an FT2 song", () => {
  function xmSong(orders: number[], rowCounts: number[]): XmSong {
    const s = emptyXmSong();
    return {
      ...s,
      patterns: rowCounts.map((r) => emptyXmPattern(r, s.channelCount)),
      songLength: orders.length,
      orders: Object.assign(s.orders.slice(), orders),
    };
  }

  it("repeat, then duplicate, gives an editable copy of the run", () => {
    let s = xmSong([0, 1, 2, 3], [64, 32, 16, 64]);
    s = setXmCell(s, 1, 3, 0, { note: 49, instrument: 1 });
    const repeated = repeatXmOrderRange(s, 1, 2);
    expect(live(repeated)).toEqual([0, 1, 2, 1, 2, 3]);
    const copied = duplicateXmPatternsInRange(repeated, 3, 4);
    expect(live(copied)).toEqual([0, 1, 2, 4, 5, 3]);
    // Each copy keeps its own row count and its notes.
    expect(copied.patterns[4]!.rowCount).toBe(32);
    expect(copied.patterns[5]!.rowCount).toBe(16);
    expect(copied.patterns[4]!.rows[3]![0]!.note).toBe(49);
    expect(copied.patterns[4]!.rows).not.toBe(copied.patterns[1]!.rows);
  });

  it("repeat respects FT2's larger order cap", () => {
    const full = xmSong(
      Array.from({ length: XM_MAX_ORDERS - 1 }, () => 0),
      [64],
    );
    expect(repeatXmOrderRange(full, 0, 1)).toBe(full);
    expect(repeatXmOrderRange(full, 0, 0).songLength).toBe(XM_MAX_ORDERS);
  });

  it("delete removes the run", () => {
    expect(
      live(deleteXmOrderRange(xmSong([0, 1, 2, 3], [64, 64, 64, 64]), 1, 2)),
    ).toEqual([0, 3]);
  });
});
