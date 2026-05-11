/**
 * Range / clipboard ops on `XmSong` patterns. Mirrors `core/mod/clipboardOps`
 * for PT — the only meaningful differences are XM's variable per-pattern
 * row count and per-song channel count, which we read off the pattern
 * itself rather than the PT constants.
 */

import { emptyXmNote } from "./format";
import type { XmNote, XmPattern, XmSong } from "./types";

/**
 * Range over a single pattern (resolved via `song.orders[order]`). All
 * indices are inclusive and pre-normalised (`start <= end`).
 */
export interface XmPatternRange {
  order: number;
  startRow: number;
  endRow: number;
  startChannel: number;
  endChannel: number;
}

/**
 * Read a slice of XM cells out of `song`. Returns `null` when the order
 * is unmapped, the pattern doesn't exist, or the range is empty. Cells
 * in the returned array are FRESH copies — callers can store them on
 * the clipboard without aliasing the song's cell objects.
 */
export function readXmSlice(
  song: XmSong,
  range: XmPatternRange,
): XmNote[][] | null {
  if (range.order < 0 || range.order >= song.songLength) return null;
  const patNum = song.orders[range.order];
  if (patNum === undefined) return null;
  const pat = song.patterns[patNum];
  if (!pat) return null;
  if (range.endRow < range.startRow) return null;
  if (range.endChannel < range.startChannel) return null;

  const rows: XmNote[][] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: XmNote[] = [];
    for (let c = range.startChannel; c <= range.endChannel; c++) {
      const cell = pat.rows[r]?.[c];
      row.push(cell ? { ...cell } : emptyXmNote());
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Zero out every cell inside `range`. Returns a new XmSong; rows /
 * patterns outside the range share refs with the input. No-op (returns
 * the same song reference) when the range doesn't resolve.
 */
export function clearXmRange(song: XmSong, range: XmPatternRange): XmSong {
  const target = resolveAndCloneRange(song, range);
  if (!target) return song;
  const { newPatterns, patNum, pattern, sR, eR, sC, eC } = target;
  const newRows: XmNote[][] = [...pattern.rows];
  for (let r = sR; r <= eR; r++) {
    const oldRow = newRows[r];
    if (!oldRow) continue;
    const newRow: XmNote[] = [...oldRow];
    for (let c = sC; c <= eC; c++) newRow[c] = emptyXmNote();
    newRows[r] = newRow;
  }
  newPatterns[patNum] = { rows: newRows, rowCount: pattern.rowCount };
  return { ...song, patterns: newPatterns };
}

/**
 * Stamp `slice` into the song starting at `(order, row, channel)`. Cells
 * extending past the pattern's variable rowCount or song.channelCount
 * are silently clipped — same friendly "paste at cursor" policy as PT.
 *
 * Returns the same XmSong reference when nothing changed (out of range,
 * empty slice, or all destinations clipped).
 */
export function pasteXmSlice(
  song: XmSong,
  slice: XmNote[][],
  order: number,
  row: number,
  channel: number,
): XmSong {
  if (slice.length === 0) return song;
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const pattern = song.patterns[patNum];
  if (!pattern) return song;

  const newRows: XmNote[][] = [...pattern.rows];
  let touched = false;
  for (let dr = 0; dr < slice.length; dr++) {
    const r = row + dr;
    if (r < 0 || r >= pattern.rowCount) continue;
    const sliceRow = slice[dr];
    if (!sliceRow) continue;
    const oldRow = newRows[r];
    if (!oldRow) continue;
    const newRow: XmNote[] = [...oldRow];
    let rowChanged = false;
    for (let dc = 0; dc < sliceRow.length; dc++) {
      const c = channel + dc;
      if (c < 0 || c >= song.channelCount) continue;
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

  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

interface RangeContext {
  newPatterns: XmPattern[];
  patNum: number;
  pattern: XmPattern;
  sR: number;
  eR: number;
  sC: number;
  eC: number;
}

function resolveAndCloneRange(
  song: XmSong,
  range: XmPatternRange,
): RangeContext | null {
  if (range.order < 0 || range.order >= song.songLength) return null;
  const patNum = song.orders[range.order];
  if (patNum === undefined) return null;
  const pattern = song.patterns[patNum];
  if (!pattern) return null;
  const sR = Math.max(0, range.startRow);
  const eR = Math.min(pattern.rowCount - 1, range.endRow);
  const sC = Math.max(0, range.startChannel);
  const eC = Math.min(song.channelCount - 1, range.endChannel);
  if (eR < sR || eC < sC) return null;
  return { newPatterns: [...song.patterns], patNum, pattern, sR, eR, sC, eC };
}
