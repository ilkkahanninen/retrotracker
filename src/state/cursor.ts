import { createSignal } from 'solid-js';
import type { Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { flattenSong } from '../core/mod/flatten';

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
export const FIELDS = ['note', 'sampleHi', 'sampleLo', 'effectCmd', 'effectHi', 'effectLo'] as const;
export type Field = (typeof FIELDS)[number];

/** True if the field accepts a hex-digit (0..F) entry — every field except note. */
export function isHexField(f: Field): boolean {
  return f !== 'note';
}

export interface Cursor {
  order: number;
  /** Pattern-relative row (0..63). */
  row: number;
  /** Channel 0..3. */
  channel: number;
  field: Field;
}

export const INITIAL_CURSOR: Cursor = { order: 0, row: 0, channel: 0, field: 'note' };

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

/** Find the cursor's index in the flat list, or -1 if its row is hidden. */
function flatIndexOf(c: Cursor, song: Song): number {
  const flat = flattenSong(song);
  for (let i = 0; i < flat.length; i++) {
    const fr = flat[i]!;
    if (fr.order === c.order && fr.rowIndex === c.row) return i;
  }
  return -1;
}

/** Place the cursor at the given flat-list index (clamped). */
function atFlatIndex(c: Cursor, song: Song, target: number): Cursor {
  const flat = flattenSong(song);
  if (flat.length === 0) return c;
  const clamped = Math.max(0, Math.min(flat.length - 1, target));
  const fr = flat[clamped]!;
  return { ...c, order: fr.order, row: fr.rowIndex };
}

export function moveLeft(c: Cursor): Cursor {
  const idx = FIELDS.indexOf(c.field);
  if (idx > 0) return { ...c, field: FIELDS[idx - 1]! };
  // Wrap to previous channel's last field; from channel 0 wrap to channel CHANNELS-1.
  const prevCh = (c.channel - 1 + CHANNELS) % CHANNELS;
  return { ...c, channel: prevCh, field: FIELDS[FIELDS.length - 1]! };
}

export function moveRight(c: Cursor): Cursor {
  const idx = FIELDS.indexOf(c.field);
  if (idx < FIELDS.length - 1) return { ...c, field: FIELDS[idx + 1]! };
  // Wrap to next channel's note; from last channel wrap to channel 0.
  const nextCh = (c.channel + 1) % CHANNELS;
  return { ...c, channel: nextCh, field: FIELDS[0]! };
}

// Hidden (Dxx-truncated) rows treat their flat index as 0 so a step still
// lands on a visible row at or before the cursor.
function moveByRows(c: Cursor, song: Song, delta: number): Cursor {
  const idx = flatIndexOf(c, song);
  return atFlatIndex(c, song, (idx < 0 ? 0 : idx) + delta);
}

export function moveUp(c: Cursor, song: Song): Cursor {
  return moveByRows(c, song, -1);
}

export function moveDown(c: Cursor, song: Song): Cursor {
  return moveByRows(c, song, 1);
}

export function pageUp(c: Cursor, song: Song, pageRows: number): Cursor {
  return moveByRows(c, song, -Math.max(1, pageRows));
}

export function pageDown(c: Cursor, song: Song, pageRows: number): Cursor {
  return moveByRows(c, song, Math.max(1, pageRows));
}

/** Tab → next channel's note (wraps from last channel to first). */
export function tabNext(c: Cursor): Cursor {
  return { ...c, channel: (c.channel + 1) % CHANNELS, field: FIELDS[0]! };
}

/** Shift+Tab → previous channel's note (wraps from first to last). */
export function tabPrev(c: Cursor): Cursor {
  return { ...c, channel: (c.channel - 1 + CHANNELS) % CHANNELS, field: FIELDS[0]! };
}
