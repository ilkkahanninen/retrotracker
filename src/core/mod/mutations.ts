import type { Note, Pattern, Song } from './types';
import { MAX_ORDERS } from './types';
import { emptyNote, emptyPattern } from './format';

/**
 * Return a new Song with one cell's fields overridden, sharing every other
 * pattern/row/cell by reference. Suitable for `commitEdit`'s undo snapshots.
 *
 * No-ops (returns the same Song reference) when the addressed cell is out
 * of range, when the order is unmapped, or when the patch wouldn't change
 * any of the existing fields.
 */
export function setCell(
  song: Song,
  order: number,
  row: number,
  channel: number,
  patch: Partial<Note>,
): Song {
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const pattern = song.patterns[patNum];
  if (!pattern) return song;
  const oldRow = pattern.rows[row];
  if (!oldRow) return song;
  const oldCell = oldRow[channel];
  if (!oldCell) return song;

  // Reference-equal short-circuit: skip building new arrays if nothing changed.
  let changed = false;
  for (const k of Object.keys(patch) as (keyof Note)[]) {
    if (oldCell[k] !== patch[k]) { changed = true; break; }
  }
  if (!changed) return song;

  const newCell: Note = { ...oldCell, ...patch };
  const newRow: Note[] = [...oldRow];
  newRow[channel] = newCell;
  const newRows: Note[][] = [...pattern.rows];
  newRows[row] = newRow;
  const newPattern: Pattern = { rows: newRows };
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Resolve `(order)` to a concrete pattern + index, or null if the order is
 * out of range or unmapped. Shared by the row-shifting mutations below.
 */
function resolvePattern(song: Song, order: number): { pattern: Pattern; patNum: number } | null {
  if (order < 0 || order >= song.songLength) return null;
  const patNum = song.orders[order];
  if (patNum === undefined) return null;
  const pattern = song.patterns[patNum];
  if (!pattern) return null;
  return { pattern, patNum };
}

/**
 * Build a new Song where the cells on `channel` from `fromRow` onward are
 * replaced with `nextCells[i]`, leaving every other row/channel/pattern
 * shared by reference. `nextCells` must have exactly `pattern.rows.length -
 * fromRow` entries.
 *
 * Returns the input Song reference unchanged when no replacement actually
 * differs from the existing cell — same short-circuit shape as `setCell`.
 */
function replaceChannelTail(
  song: Song,
  patNum: number,
  pattern: Pattern,
  channel: number,
  fromRow: number,
  nextCells: Note[],
): Song {
  let changed = false;
  for (let i = 0; i < nextCells.length; i++) {
    if (pattern.rows[fromRow + i]![channel] !== nextCells[i]) { changed = true; break; }
  }
  if (!changed) return song;

  const newRows: Note[][] = [...pattern.rows];
  for (let i = 0; i < nextCells.length; i++) {
    const r = fromRow + i;
    const oldRow = pattern.rows[r]!;
    const newRow: Note[] = [...oldRow];
    newRow[channel] = nextCells[i]!;
    newRows[r] = newRow;
  }
  const newPattern: Pattern = { rows: newRows };
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Delete the cell at (order, row, channel) and pull every cell below it on
 * the same channel up by one row. The pattern's last row on this channel
 * becomes an empty note. Other channels are untouched.
 *
 * No-op when the address is out of range.
 */
export function deleteCellPullUp(song: Song, order: number, row: number, channel: number): Song {
  const ctx = resolvePattern(song, order);
  if (!ctx) return song;
  const { pattern, patNum } = ctx;
  if (row < 0 || row >= pattern.rows.length) return song;
  if (channel < 0 || channel >= (pattern.rows[0]?.length ?? 0)) return song;

  const tail: Note[] = [];
  for (let r = row + 1; r < pattern.rows.length; r++) tail.push(pattern.rows[r]![channel]!);
  tail.push(emptyNote());
  return replaceChannelTail(song, patNum, pattern, channel, row, tail);
}

/**
 * Insert an empty cell at (order, row, channel), shifting every cell at or
 * below this row on the same channel down by one. The cell that was on the
 * last row of this channel falls off the end. Other channels are untouched.
 *
 * No-op when the address is out of range.
 */
export function insertCellPushDown(song: Song, order: number, row: number, channel: number): Song {
  const ctx = resolvePattern(song, order);
  if (!ctx) return song;
  const { pattern, patNum } = ctx;
  if (row < 0 || row >= pattern.rows.length) return song;
  if (channel < 0 || channel >= (pattern.rows[0]?.length ?? 0)) return song;

  const tail: Note[] = [emptyNote()];
  for (let r = row; r < pattern.rows.length - 1; r++) tail.push(pattern.rows[r]![channel]!);
  return replaceChannelTail(song, patNum, pattern, channel, row, tail);
}

// ─── Order list ───────────────────────────────────────────────────────────

/**
 * Replace the pattern number at `song.orders[order]`. No-op if the order is
 * out of range, the target pattern doesn't exist, or the slot already points
 * at it.
 */
export function setOrderPattern(song: Song, order: number, patNum: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  if (patNum < 0 || patNum >= song.patterns.length) return song;
  if (song.orders[order] === patNum) return song;
  const newOrders = [...song.orders];
  newOrders[order] = patNum;
  return { ...song, orders: newOrders };
}

/**
 * Step the pattern number at `order` by +1. If the new number would go past
 * the last existing pattern, append a fresh empty pattern and point the slot
 * at it (FT2-style auto-grow). No-op when the order is out of range.
 */
export function nextPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const next = cur + 1;
  if (next < song.patterns.length) return setOrderPattern(song, order, next);
  // Auto-grow: append a new empty pattern and point the slot at it.
  const newPatterns: Pattern[] = [...song.patterns, emptyPattern()];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/**
 * Step the pattern number at `order` by -1, clamped at 0. No-op when the
 * order is out of range or the slot is already at pattern 0.
 */
export function prevPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  if (cur <= 0) return song;
  return setOrderPattern(song, order, cur - 1);
}

/**
 * Insert a new order slot at index `order`, shifting subsequent slots right
 * by one. The inserted slot duplicates the current slot's pattern number, so
 * the user sees the same pattern at the new position and can step from there.
 *
 * No-op if the song is already at MAX_ORDERS (128) or `order` is out of range.
 */
export function insertOrder(song: Song, order: number): Song {
  if (song.songLength >= MAX_ORDERS) return song;
  if (order < 0 || order > song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const newOrders = [...song.orders];
  for (let i = newOrders.length - 1; i > order; i--) {
    newOrders[i] = newOrders[i - 1] ?? 0;
  }
  newOrders[order] = cur;
  return { ...song, orders: newOrders, songLength: song.songLength + 1 };
}

/**
 * Delete the order slot at `order`, pulling subsequent slots left. The last
 * (now unused) slot resets to 0. No-op when the song is already at length 1
 * — we keep at least one playable order — or `order` is out of range.
 *
 * Note: this only edits the orders array. Patterns the deleted slot pointed
 * to remain in `song.patterns`, since other slots may still reference them.
 */
export function deleteOrder(song: Song, order: number): Song {
  if (song.songLength <= 1) return song;
  if (order < 0 || order >= song.songLength) return song;
  const newOrders = [...song.orders];
  for (let i = order; i < newOrders.length - 1; i++) {
    newOrders[i] = newOrders[i + 1] ?? 0;
  }
  newOrders[newOrders.length - 1] = 0;
  return { ...song, orders: newOrders, songLength: song.songLength - 1 };
}

/**
 * Append a fresh empty pattern and point `song.orders[order]` at it. Lets the
 * user blank out a slot without having to step through pattern numbers, and
 * leaves the previously-pointed-at pattern intact (other slots may still
 * reference it). No-op when `order` is out of range.
 */
export function newPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const newPatterns: Pattern[] = [...song.patterns, emptyPattern()];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/**
 * Append a copy of the pattern under `order` and point the slot at the copy.
 * The previously-pointed-at pattern stays intact (other slots may share it).
 *
 * The copy clones the rows array and each row, but shares Note references —
 * Notes are treated as immutable elsewhere, and `setCell` rewrites the row
 * arrays it touches, so future edits to the copy can't bleed into the source.
 *
 * No-op when `order` is out of range or the slot points at a missing pattern.
 */
export function duplicatePatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const source = song.patterns[patNum];
  if (!source) return song;
  const dup: Pattern = { rows: source.rows.map((row) => [...row]) };
  const newPatterns: Pattern[] = [...song.patterns, dup];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}
