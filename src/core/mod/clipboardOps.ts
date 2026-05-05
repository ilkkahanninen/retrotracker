import type { Note, Pattern, Song } from "./types";
import { CHANNELS } from "./types";
import { emptyNote } from "./format";

/**
 * Range over a single pattern (resolved via `song.orders[order]`). All
 * indices are inclusive and pre-normalised (`start <= end`).
 */
export interface PatternRange {
  order: number;
  startRow: number;
  endRow: number;
  startChannel: number;
  endChannel: number;
}

/**
 * Read a slice of notes out of `song`. Returns `null` when the order is
 * unmapped, the pattern doesn't exist, or the range is empty. The cells in
 * the returned array are FRESH copies — callers can store them on the
 * clipboard without aliasing the song's note objects.
 */
export function readSlice(song: Song, range: PatternRange): Note[][] | null {
  if (range.order < 0 || range.order >= song.songLength) return null;
  const patNum = song.orders[range.order];
  if (patNum === undefined) return null;
  const pat = song.patterns[patNum];
  if (!pat) return null;
  if (range.endRow < range.startRow) return null;
  if (range.endChannel < range.startChannel) return null;

  const rows: Note[][] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: Note[] = [];
    for (let c = range.startChannel; c <= range.endChannel; c++) {
      const cell = pat.rows[r]?.[c];
      row.push(cell ? { ...cell } : emptyNote());
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Zero out every cell inside `range`. Returns a new Song; rows / patterns
 * outside the range share refs with the input. No-op (returns the same
 * song reference) when the range doesn't resolve to a real pattern.
 */
export function clearRange(song: Song, range: PatternRange): Song {
  const target = resolveAndCloneRange(song, range);
  if (!target) return song;
  const { newPatterns, patNum, pattern, sR, eR, sC, eC } = target;
  const newRows: Note[][] = [...pattern.rows];
  for (let r = sR; r <= eR; r++) {
    const oldRow = newRows[r];
    if (!oldRow) continue;
    const newRow: Note[] = [...oldRow];
    for (let c = sC; c <= eC; c++) newRow[c] = emptyNote();
    newRows[r] = newRow;
  }
  newPatterns[patNum] = { rows: newRows };
  return { ...song, patterns: newPatterns };
}

/**
 * Stamp `slice` into the song starting at `(order, row, channel)`. Anything
 * extending past pattern bounds (row >= 64, channel >= 4) is silently
 * clipped — the user can paste a tall slice near the bottom and the
 * trailing rows just disappear, which is the friendliest behaviour for
 * "paste at cursor".
 *
 * Returns a new Song; an empty / out-of-range slice returns the same ref.
 */
export function pasteSlice(
  song: Song,
  slice: Note[][],
  order: number,
  row: number,
  channel: number,
): Song {
  if (slice.length === 0) return song;
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const pattern = song.patterns[patNum];
  if (!pattern) return song;

  const newRows: Note[][] = [...pattern.rows];
  let touched = false;
  for (let dr = 0; dr < slice.length; dr++) {
    const r = row + dr;
    if (r < 0 || r >= pattern.rows.length) continue;
    const sliceRow = slice[dr];
    if (!sliceRow) continue;
    const oldRow = newRows[r];
    if (!oldRow) continue;
    const newRow: Note[] = [...oldRow];
    let rowChanged = false;
    for (let dc = 0; dc < sliceRow.length; dc++) {
      const c = channel + dc;
      if (c < 0 || c >= CHANNELS) continue;
      const src = sliceRow[dc];
      if (!src) continue;
      newRow[c] = { ...src };
      rowChanged = true;
    }
    if (rowChanged) {
      newRows[r] = newRow;
      touched = true;
    }
  }
  if (!touched) return song;

  const newPattern: Pattern = { rows: newRows };
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

interface RangeContext {
  newPatterns: Pattern[];
  patNum: number;
  pattern: Pattern;
  sR: number;
  eR: number;
  sC: number;
  eC: number;
}

/**
 * Resolve a PatternRange + clone the patterns array so the caller can
 * mutate `newPatterns[patNum]` without aliasing the original Song.
 * Returns null on the same conditions as `readSlice`.
 */
function resolveAndCloneRange(
  song: Song,
  range: PatternRange,
): RangeContext | null {
  if (range.order < 0 || range.order >= song.songLength) return null;
  const patNum = song.orders[range.order];
  if (patNum === undefined) return null;
  const pattern = song.patterns[patNum];
  if (!pattern) return null;
  const sR = Math.max(0, range.startRow);
  const eR = Math.min(pattern.rows.length - 1, range.endRow);
  const sC = Math.max(0, range.startChannel);
  const eC = Math.min(CHANNELS - 1, range.endChannel);
  if (eR < sR || eC < sC) return null;
  return { newPatterns: [...song.patterns], patNum, pattern, sR, eR, sC, eC };
}
