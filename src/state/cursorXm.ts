/**
 * FT2-mode edit cursor — parallel to `state/cursor.ts` (PT2). XM patterns
 * have a wider cell (8 sub-fields including the volume column) and
 * variable channel count, so the wrap math reads `song.channelCount`
 * rather than the PT `CHANNELS=4` constant.
 *
 * Phase 3-3: signal + movement primitives + Tab navigation. The actual
 * key-input handlers (note entry, hex digit, volume column entry) land in
 * Phase 3-4 in a sibling `xmPatternEdit.ts` module.
 */

import { createSignal } from "solid-js";

import { rowsOfPattern } from "../core/song";
import type { XmSong } from "../core/xm/types";

/** The eight sub-fields inside one XM cell, in left-to-right cursor order. */
export const XM_FIELDS = [
  "note",
  "instHi",
  "instLo",
  "volHi",
  "volLo",
  "effectCmd",
  "effectHi",
  "effectLo",
] as const;
export type XmField = (typeof XM_FIELDS)[number];

/** True if the field accepts a hex-digit (0..F) entry. */
export function isXmHexField(f: XmField): boolean {
  return f !== "note";
}

export interface XmCursor {
  order: number;
  /** Pattern-relative row (0..rowCount-1 of the pattern at `orders[order]`). */
  row: number;
  /** Channel 0..channelCount-1. */
  channel: number;
  field: XmField;
}

export const INITIAL_XM_CURSOR: XmCursor = {
  order: 0,
  row: 0,
  channel: 0,
  field: "note",
};

export const [xmCursor, setXmCursor] = createSignal<XmCursor>({
  ...INITIAL_XM_CURSOR,
});

export function resetXmCursor(): void {
  setXmCursor({ ...INITIAL_XM_CURSOR });
}

// ─── Movement primitives ────────────────────────────────────────────────

export function xmMoveLeft(c: XmCursor, song: XmSong): XmCursor {
  const idx = XM_FIELDS.indexOf(c.field);
  if (idx > 0) return { ...c, field: XM_FIELDS[idx - 1]! };
  const prevCh = (c.channel - 1 + song.channelCount) % song.channelCount;
  return { ...c, channel: prevCh, field: XM_FIELDS[XM_FIELDS.length - 1]! };
}

export function xmMoveRight(c: XmCursor, song: XmSong): XmCursor {
  const idx = XM_FIELDS.indexOf(c.field);
  if (idx < XM_FIELDS.length - 1) {
    return { ...c, field: XM_FIELDS[idx + 1]! };
  }
  const nextCh = (c.channel + 1) % song.channelCount;
  return { ...c, channel: nextCh, field: XM_FIELDS[0]! };
}

/** Move N rows along the song, wrapping into adjacent orders. Snaps to the
 *  pattern's row count when an order boundary is crossed. */
export function xmMoveByRows(
  c: XmCursor,
  song: XmSong,
  delta: number,
): XmCursor {
  let order = c.order;
  let row = c.row + delta;
  while (true) {
    const patternIdx = song.orders[order] ?? 0;
    const rows = rowsOfPattern(song, patternIdx);
    if (row >= 0 && row < rows) break;
    if (row < 0) {
      if (order === 0) {
        row = 0;
        break;
      }
      order--;
      const prevPattern = song.orders[order] ?? 0;
      row += rowsOfPattern(song, prevPattern);
    } else {
      // row >= rows
      if (order >= song.songLength - 1) {
        row = rows - 1;
        break;
      }
      row -= rows;
      order++;
    }
  }
  return { ...c, order, row };
}

export function xmMoveUp(c: XmCursor, song: XmSong): XmCursor {
  return xmMoveByRows(c, song, -1);
}

export function xmMoveDown(c: XmCursor, song: XmSong): XmCursor {
  return xmMoveByRows(c, song, 1);
}

export function xmPageUp(
  c: XmCursor,
  song: XmSong,
  pageRows: number,
): XmCursor {
  return xmMoveByRows(c, song, -Math.max(1, pageRows));
}

export function xmPageDown(
  c: XmCursor,
  song: XmSong,
  pageRows: number,
): XmCursor {
  return xmMoveByRows(c, song, Math.max(1, pageRows));
}

/** Tab → next channel's note. */
export function xmTabNext(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    channel: (c.channel + 1) % song.channelCount,
    field: XM_FIELDS[0]!,
  };
}

/** Shift+Tab → previous channel's note. */
export function xmTabPrev(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    channel: (c.channel - 1 + song.channelCount) % song.channelCount,
    field: XM_FIELDS[0]!,
  };
}
