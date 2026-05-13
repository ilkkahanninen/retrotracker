import { describe, expect, it } from "vitest";

import {
  clearXmRange,
  pasteXmSlice,
  readXmSlice,
  type XmPatternRange,
} from "~/core/xm/clipboardOps";
import { emptyXmSong } from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";

const range = (
  o: number,
  sR: number,
  eR: number,
  sC: number,
  eC: number,
): XmPatternRange => ({
  order: o,
  startRow: sR,
  endRow: eR,
  startChannel: sC,
  endChannel: eC,
});

describe("readXmSlice", () => {
  it("returns a fresh-copy 2D array of the requested cells", () => {
    let s = emptyXmSong();
    s = setXmCell(s, 0, 5, 0, { note: 49 });
    s = setXmCell(s, 0, 6, 1, { instrument: 7 });
    const slice = readXmSlice(s, range(0, 5, 6, 0, 1));
    expect(slice).not.toBeNull();
    expect(slice!.length).toBe(2);
    expect(slice![0]![0]!.note).toBe(49);
    expect(slice![1]![1]!.instrument).toBe(7);
    // Mutating the slice must NOT bleed back into the source song.
    slice![0]![0]!.note = 99;
    expect(s.patterns[0]!.rows[5]![0]!.note).toBe(49);
  });

  it("returns null on out-of-range / unmapped order", () => {
    const s = emptyXmSong();
    expect(readXmSlice(s, range(99, 0, 0, 0, 0))).toBeNull();
    expect(readXmSlice(s, range(0, 5, 4, 0, 0))).toBeNull(); // inverted
  });
});

describe("clearXmRange", () => {
  it("zeros every cell in the rectangle", () => {
    let s = emptyXmSong();
    s = setXmCell(s, 0, 5, 0, { note: 49 });
    s = setXmCell(s, 0, 6, 1, { note: 50 });
    const after = clearXmRange(s, range(0, 5, 6, 0, 1));
    expect(after.patterns[0]!.rows[5]![0]!.note).toBe(0);
    expect(after.patterns[0]!.rows[6]![1]!.note).toBe(0);
  });

  it("clips to pattern bounds when the range overshoots", () => {
    let s = emptyXmSong();
    s = setXmCell(s, 0, 63, 0, { note: 49 });
    const after = clearXmRange(s, range(0, 60, 200, 0, 0));
    expect(after.patterns[0]!.rows[63]![0]!.note).toBe(0);
  });

  it("returns the same reference on non-resolving ranges", () => {
    const s = emptyXmSong();
    expect(clearXmRange(s, range(99, 0, 0, 0, 0))).toBe(s);
  });
});

describe("pasteXmSlice", () => {
  it("stamps the slice at (order, row, channel)", () => {
    let src = emptyXmSong();
    src = setXmCell(src, 0, 0, 0, { note: 49, instrument: 1 });
    src = setXmCell(src, 0, 1, 0, { note: 50, instrument: 2 });
    const slice = readXmSlice(src, range(0, 0, 1, 0, 0))!;
    let dst = emptyXmSong();
    dst = pasteXmSlice(dst, slice, 0, 10, 2);
    expect(dst.patterns[0]!.rows[10]![2]!.note).toBe(49);
    expect(dst.patterns[0]!.rows[11]![2]!.note).toBe(50);
  });

  it("clips trailing rows / channels that overshoot pattern bounds", () => {
    let src = emptyXmSong();
    src = setXmCell(src, 0, 0, 0, { note: 49 });
    const slice = readXmSlice(src, range(0, 0, 0, 0, 0))!;
    // Pattern is 64 rows; pasting a 1-row slice at row 63 fits exactly,
    // a 2-row slice at row 63 silently drops the second row.
    const big = [slice[0]!, slice[0]!];
    const dst = pasteXmSlice(emptyXmSong(), big, 0, 63, 0);
    expect(dst.patterns[0]!.rows[63]![0]!.note).toBe(49);
    // Row 64 doesn't exist (rowCount = 64 → last index 63).
    expect(dst.patterns[0]!.rows[64]).toBeUndefined();
  });

  it("returns the same reference for an empty slice", () => {
    const s = emptyXmSong();
    expect(pasteXmSlice(s, [], 0, 0, 0)).toBe(s);
  });
});
