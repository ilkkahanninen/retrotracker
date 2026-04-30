import type { Note, Pattern, Song } from './types';
import { emptyNote } from './format';

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
