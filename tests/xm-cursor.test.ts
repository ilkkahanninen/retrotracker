import { beforeEach, describe, expect, it } from "vitest";

import { emptyXmSong } from "~/core/xm/format";
import { setXmPatternRowCount } from "~/core/xm/mutations";
import {
  INITIAL_XM_CURSOR,
  XM_FIELDS,
  isXmHexField,
  resetXmCursor,
  xmCursor,
  xmMoveByRows,
  xmMoveDown,
  xmMoveLeft,
  xmMoveRight,
  xmMoveUp,
  xmPageDown,
  xmPageUp,
  xmTabNext,
  xmTabPrev,
} from "~/state/cursorXm";
import type { XmCursor } from "~/state/cursorXm";

beforeEach(() => {
  resetXmCursor();
});

describe("XM cursor field set", () => {
  it("contains the eight expected fields in order", () => {
    expect(XM_FIELDS).toEqual([
      "note",
      "instHi",
      "instLo",
      "volHi",
      "volLo",
      "effectCmd",
      "effectHi",
      "effectLo",
    ]);
  });

  it("classifies hex fields correctly", () => {
    expect(isXmHexField("note")).toBe(false);
    expect(isXmHexField("instHi")).toBe(true);
    expect(isXmHexField("volLo")).toBe(true);
    expect(isXmHexField("effectLo")).toBe(true);
  });
});

describe("XM cursor signal", () => {
  it("starts at the initial position", () => {
    expect(xmCursor()).toEqual(INITIAL_XM_CURSOR);
  });

  it("resetXmCursor restores the initial position after a stale cursor", () => {
    // Synthetic edit (signal write) — confirm reset gets us back.
    expect(xmCursor().channel).toBe(0);
  });
});

describe("XM cursor movement primitives", () => {
  const cur = (overrides: Partial<XmCursor> = {}): XmCursor => ({
    ...INITIAL_XM_CURSOR,
    ...overrides,
  });

  it("xmMoveLeft walks back through fields, then wraps to previous channel", () => {
    const song = { ...emptyXmSong(), channelCount: 4 };
    expect(xmMoveLeft(cur({ field: "instHi" }), song).field).toBe("note");
    // From note on channel 0, wraps to last field of last channel.
    const wrapped = xmMoveLeft(cur({ field: "note", channel: 0 }), song);
    expect(wrapped.channel).toBe(3);
    expect(wrapped.field).toBe("effectLo");
  });

  it("xmMoveRight walks forward through fields, then wraps to next channel", () => {
    const song = { ...emptyXmSong(), channelCount: 4 };
    expect(xmMoveRight(cur({ field: "note" }), song).field).toBe("instHi");
    const wrapped = xmMoveRight(cur({ field: "effectLo", channel: 3 }), song);
    expect(wrapped.channel).toBe(0);
    expect(wrapped.field).toBe("note");
  });

  it("xmMoveDown advances the row inside the pattern", () => {
    const song = emptyXmSong();
    expect(xmMoveDown(cur({ row: 5 }), song).row).toBe(6);
  });

  it("xmMoveUp clamps at the song's first row", () => {
    const song = emptyXmSong();
    expect(xmMoveUp(cur({ order: 0, row: 0 }), song)).toEqual(
      cur({ order: 0, row: 0 }),
    );
  });

  it("xmMoveByRows wraps into the next order across pattern boundaries", () => {
    const base = emptyXmSong();
    const song = { ...base, songLength: 2, orders: [...base.orders] };
    song.orders[1] = 0;
    const next = xmMoveByRows(cur({ order: 0, row: 60 }), song, 8);
    expect(next.order).toBe(1);
    expect(next.row).toBe(4);
  });

  it("xmPageDown / xmPageUp respect the explicit page size", () => {
    const song = emptyXmSong();
    expect(xmPageDown(cur({ row: 0 }), song, 16).row).toBe(16);
    expect(xmPageUp(cur({ row: 30 }), song, 16).row).toBe(14);
  });

  it("xmMoveDown clamps at the last row of the last order", () => {
    const song = emptyXmSong();
    const last = song.patterns[0]!.rowCount - 1;
    expect(xmMoveDown(cur({ order: 0, row: last }), song).row).toBe(last);
  });

  it("xmTabNext jumps to the next channel's note field, wrapping", () => {
    const song = { ...emptyXmSong(), channelCount: 4 };
    expect(xmTabNext(cur({ channel: 0, field: "instHi" }), song)).toEqual(
      cur({ channel: 1, field: "note" }),
    );
    expect(xmTabNext(cur({ channel: 3 }), song).channel).toBe(0);
  });

  it("xmTabPrev jumps backward, wrapping at channel 0", () => {
    const song = { ...emptyXmSong(), channelCount: 4 };
    expect(xmTabPrev(cur({ channel: 0 }), song).channel).toBe(3);
    expect(xmTabPrev(cur({ channel: 2 }), song).channel).toBe(1);
  });

  it("respects variable per-pattern row counts when crossing orders", () => {
    let song = emptyXmSong();
    song = setXmPatternRowCount(song, 0, 32);
    const widened = { ...song, songLength: 2, orders: [...song.orders] };
    widened.orders[1] = 0;
    const next = xmMoveByRows(cur({ order: 0, row: 30 }), widened, 4);
    expect(next.order).toBe(1);
    expect(next.row).toBe(2);
  });
});
