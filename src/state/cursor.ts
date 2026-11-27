import { createSignal } from "solid-js";
import type { ModSong } from "../core/mod/types";
import { CHANNELS } from "../core/mod/types";
import { flattenSong } from "../core/mod/flatten";
import {
  cycleChannel,
  moveAlongFields,
  moveByFlatRows,
} from "./cursorPrimitives";

/**
 * Edit cursor.
 *
 * Tracks the user's editing position in the pattern grid. Independent from
 * the playback head — both can be visible simultaneously.
 *
 * The cursor's row coordinate is `(order, row)`, mirroring how cells are
 * addressed in the song. Up/Down navigation walks the *visible* flat list
 * (Dxx-truncated, multi-pattern), so reaching the last visible row of one
 * pattern naturally advances into the next.
 */

/** The six sub-fields inside one cell, in left-to-right cursor order. */
export const FIELDS = [
  "note",
  "sampleHi",
  "sampleLo",
  "effectCmd",
  "effectHi",
  "effectLo",
] as const;
export type Field = (typeof FIELDS)[number];

/** True if the field accepts a hex-digit (0..F) entry — every field except note. */
export function isHexField(f: Field): boolean {
  return f !== "note";
}

export interface Cursor {
  order: number;
  /** Pattern-relative row (0..63). */
  row: number;
  /** Channel 0..3. */
  channel: number;
  field: Field;
}

export const INITIAL_CURSOR: Cursor = {
  order: 0,
  row: 0,
  channel: 0,
  field: "note",
};

export const [cursor, setCursor] = createSignal<Cursor>({ ...INITIAL_CURSOR });

export function resetCursor(): void {
  setCursor({ ...INITIAL_CURSOR });
}

/**
 * Monotonic "jump request" counter, bumped whenever the cursor was moved by
 * a discrete navigation action (clicking an order-list slot, inserting a
 * slot) where the user expects the pattern grid to snap the cursor to the
 * top of the viewport rather than gently scrolling on its margin. Plain
 * arrow / page navigation does NOT bump this — those keep the existing
 * "scroll only when the cursor crosses the margin" behaviour.
 *
 * The PatternGrid subscribes to this counter and scrolls cursor → top each
 * time the counter ticks. Storing a counter (not a boolean / position) lets
 * consecutive jumps to the same order still re-trigger the scroll.
 */
export const [jumpRequest, setJumpRequest] = createSignal(0);

/** Bump `jumpRequest` so the PatternGrid snaps the cursor row to the top. */
export function requestJumpToTop(): void {
  setJumpRequest((n) => n + 1);
}

// ─── Pure movement primitives ─────────────────────────────────────────────

export function moveLeft(c: Cursor): Cursor {
  return { ...c, ...moveAlongFields(FIELDS, c.field, -1, CHANNELS, c.channel) };
}

export function moveRight(c: Cursor): Cursor {
  return { ...c, ...moveAlongFields(FIELDS, c.field, 1, CHANNELS, c.channel) };
}

/** Move through the rows the grid shows — Dxx-aware, crossing orders. */
export function moveByRows(c: Cursor, song: ModSong, delta: number): Cursor {
  return moveByFlatRows(c, flattenSong(song), delta);
}

export function moveUp(c: Cursor, song: ModSong): Cursor {
  return moveByRows(c, song, -1);
}

export function moveDown(c: Cursor, song: ModSong): Cursor {
  return moveByRows(c, song, 1);
}

export function pageUp(c: Cursor, song: ModSong, pageRows: number): Cursor {
  return moveByRows(c, song, -Math.max(1, pageRows));
}

export function pageDown(c: Cursor, song: ModSong, pageRows: number): Cursor {
  return moveByRows(c, song, Math.max(1, pageRows));
}

export function tabNext(c: Cursor): Cursor {
  return {
    ...c,
    channel: cycleChannel(c.channel, 1, CHANNELS),
    field: FIELDS[0]!,
  };
}

export function tabPrev(c: Cursor): Cursor {
  return {
    ...c,
    channel: cycleChannel(c.channel, -1, CHANNELS),
    field: FIELDS[0]!,
  };
}
