import { createSignal } from "solid-js";

import { rowsOfPattern } from "../core/song";
import { flattenXmSong } from "../core/xm/flatten";
import type { XmSong } from "../core/xm/types";
import {
  cycleChannel,
  moveAlongFields,
  moveByFlatRows,
} from "./cursorPrimitives";

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

export function isXmHexField(f: XmField): boolean {
  return f !== "note";
}

export interface XmCursor {
  order: number;
  row: number;
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

export function xmMoveLeft(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    ...moveAlongFields(XM_FIELDS, c.field, -1, song.channelCount, c.channel),
  };
}

export function xmMoveRight(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    ...moveAlongFields(XM_FIELDS, c.field, 1, song.channelCount, c.channel),
  };
}

/**
 * Move through the rows the grid shows — Dxx-aware, crossing orders —
 * with the same primitive the PT cursor uses. It used to step raw
 * pattern rows, so the cursor could walk onto rows a pattern break
 * hides and vanish from the grid.
 */
export function xmMoveByRows(
  c: XmCursor,
  song: XmSong,
  delta: number,
): XmCursor {
  return moveByFlatRows(c, flattenXmSong(song), delta);
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

export function xmTabNext(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    channel: cycleChannel(c.channel, 1, song.channelCount),
    field: XM_FIELDS[0]!,
  };
}

export function xmTabPrev(c: XmCursor, song: XmSong): XmCursor {
  return {
    ...c,
    channel: cycleChannel(c.channel, -1, song.channelCount),
    field: XM_FIELDS[0]!,
  };
}
