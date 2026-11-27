import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { visibleRowRange } from "~/core/flatten";
import { emptyXmPattern, emptyXmSong } from "~/core/xm/format";
import { flattenXmSong } from "~/core/xm/flatten";
import { setXmCell } from "~/core/xm/mutations";
import type { XmSong } from "~/core/xm/types";
import { moveByFlatRows } from "~/state/cursorPrimitives";
import {
  resetXmCursor,
  setXmCursor,
  xmCursor,
  xmMoveByRows,
  xmMoveDown,
  xmMoveUp,
  xmPageDown,
  type XmCursor,
} from "~/state/cursorXm";
import { setEditStep } from "~/state/edit";
import { clearXmSelection, xmSelection } from "~/state/selection";
import { clearHistory, setSong, setTransport } from "~/state/song";
import { setCurrentXmInstrument, setCurrentXmOctave } from "~/state/xmEdit";
import {
  enterXmNote,
  extendXmSelection,
  selectAllXmStep,
  stepXmRowDown,
  stepXmRowPageDown,
} from "~/state/xmPatternEdit";

/**
 * A Dxx pattern break hides the rest of its pattern (and the next
 * pattern's rows before the break target) from the FT2 grid. The cursor
 * and selection used to step raw pattern rows, so they walked onto rows
 * the grid doesn't show and vanished. They now move through the same
 * visible-row list the grid draws, like the PT cursor.
 */

const D = 0x0d;

/** Two orders on two 64-row patterns. Pattern 0 breaks at row 9 to row 4
 *  of the next: visible rows are (0, 0..9) then (1, 4..63). */
function brokenSong(): XmSong {
  let s = emptyXmSong();
  s = {
    ...s,
    patterns: [
      emptyXmPattern(64, s.channelCount),
      emptyXmPattern(64, s.channelCount),
    ],
    songLength: 2,
    orders: Object.assign(s.orders.slice(), [0, 1]),
  };
  return setXmCell(s, 0, 9, 0, { effect: D, effectParam: 0x04 });
}

const at = (order: number, row: number): XmCursor => ({
  order,
  row,
  channel: 0,
  field: "note",
});
const pos = (c: XmCursor) => [c.order, c.row];

describe("xmMoveByRows across a pattern break", () => {
  const s = brokenSong();

  it("down from the break row lands on the break target", () => {
    expect(pos(xmMoveDown(at(0, 9), s))).toEqual([1, 4]);
  });

  it("up from the break target lands back on the break row", () => {
    expect(pos(xmMoveUp(at(1, 4), s))).toEqual([0, 9]);
  });

  it("paging counts visible rows only", () => {
    // 5 → 9 is four visible rows, then (1,4), (1,5), … : 16 rows lands on (1, 15).
    expect(pos(xmPageDown(at(0, 5), s, 16))).toEqual([1, 15]);
  });

  it("a cursor stranded on a hidden row snaps to the last visible one first", () => {
    // Row 30 of order 0 is hidden; the last visible row at or before it is 9.
    expect(pos(xmMoveByRows(at(0, 30), s, 0))).toEqual([0, 9]);
    expect(pos(xmMoveDown(at(0, 30), s))).toEqual([1, 4]);
    expect(pos(xmMoveUp(at(0, 30), s))).toEqual([0, 8]);
    // Rows 0..3 of order 1 are hidden too — skipped by the break target.
    expect(pos(xmMoveByRows(at(1, 2), s, 0))).toEqual([0, 9]);
  });

  it("clamps at both ends of the song", () => {
    expect(pos(xmMoveByRows(at(0, 0), s, -5))).toEqual([0, 0]);
    expect(pos(xmMoveByRows(at(1, 60), s, 50))).toEqual([1, 63]);
  });

  it("a song without breaks moves exactly as before", () => {
    const plain = {
      ...brokenSong(),
      patterns: [emptyXmPattern(64, 8), emptyXmPattern(32, 8)],
    };
    expect(pos(xmMoveDown(at(0, 63), plain))).toEqual([1, 0]);
    expect(pos(xmMoveUp(at(1, 0), plain))).toEqual([0, 63]);
    expect(pos(xmMoveByRows(at(1, 31), plain, 1))).toEqual([1, 31]);
  });
});

describe("visibleRowRange", () => {
  it("reports the rows of an order the grid shows", () => {
    const flat = flattenXmSong(brokenSong());
    expect(visibleRowRange(flat, 0)).toEqual({ first: 0, last: 9 });
    expect(visibleRowRange(flat, 1)).toEqual({ first: 4, last: 63 });
    expect(visibleRowRange(flat, 7)).toBeNull();
  });
});

describe("moveByFlatRows", () => {
  it("returns the cursor untouched for an empty list", () => {
    const c = at(3, 3);
    expect(moveByFlatRows(c, [], 1)).toBe(c);
  });
});

describe("FT2 editing around a pattern break", () => {
  beforeEach(() => {
    setSong(brokenSong());
    resetXmCursor();
    clearXmSelection();
    setCurrentXmOctave(4);
    setCurrentXmInstrument(1);
    setEditStep(1);
    setTransport("idle");
    clearHistory();
  });
  afterEach(() => {
    setSong(null);
    setEditStep(1);
    clearHistory();
  });

  it("the edit-step advance skips hidden rows", () => {
    setEditStep(4);
    setXmCursor(at(0, 8));
    enterXmNote(0);
    // 8 → 9 → (1,4) → (1,5) → (1,6).
    expect(pos(xmCursor())).toEqual([1, 6]);
  });

  it("shift+down selection stops at the last visible row", () => {
    setXmCursor(at(0, 8));
    extendXmSelection(stepXmRowDown(xmCursor()));
    extendXmSelection(stepXmRowDown(xmCursor()));
    extendXmSelection(stepXmRowDown(xmCursor()));
    expect(xmSelection()).toMatchObject({ order: 0, startRow: 8, endRow: 9 });
  });

  it("shift+page-down selection stops at the last visible row", () => {
    setXmCursor(at(0, 2));
    extendXmSelection(stepXmRowPageDown(xmCursor(), 16));
    extendXmSelection(stepXmRowPageDown(xmCursor(), 16));
    expect(xmSelection()).toMatchObject({ order: 0, startRow: 2, endRow: 9 });
  });

  it("select-all covers the visible rows of the pattern, not the hidden tail", () => {
    setXmCursor(at(0, 3));
    selectAllXmStep();
    expect(xmSelection()).toMatchObject({ order: 0, startRow: 0, endRow: 9 });
    clearXmSelection();
    setXmCursor(at(1, 10));
    selectAllXmStep();
    expect(xmSelection()).toMatchObject({ order: 1, startRow: 4, endRow: 63 });
  });
});
