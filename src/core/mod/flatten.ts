import type { Note, Song } from './types';
import { Effect } from './format';

export interface FlatRow {
  /** Index into song.orders. */
  order: number;
  /** Pattern-relative row index (used for beat/bar markers and the row label). */
  rowIndex: number;
  cells: Note[];
  /** Render a dashed divider above this row (true on the first row of a new pattern segment). */
  boundaryAbove: boolean;
}

/**
 * Walk the order list and produce a single flat row list.
 *
 * Dxx (Pattern Break) truncates the rest of the current pattern; the next
 * order resumes at the Dxx-target row. Bxx and pattern-loop are deliberately
 * NOT honored here — they would create infinite views for songs that loop.
 *
 * If multiple Dxx commands appear on the same row, the last one (highest
 * channel index) wins for the resume row, matching pt2-clone.
 */
export function flattenSong(song: Song): FlatRow[] {
  const out: FlatRow[] = [];
  let nextStartRow = 0;
  for (let o = 0; o < song.songLength; o++) {
    const pat = song.patterns[song.orders[o] ?? 0];
    if (!pat) continue;
    const startRow = Math.min(nextStartRow, pat.rows.length - 1);
    nextStartRow = 0;
    for (let r = startRow; r < pat.rows.length; r++) {
      const cells = pat.rows[r]!;
      out.push({
        order: o,
        rowIndex: r,
        cells,
        boundaryAbove: r === startRow && o > 0,
      });
      let dxx = -1;
      for (const c of cells) {
        if (c.effect === Effect.PatternBreak) dxx = c.effectParam;
      }
      if (dxx >= 0) {
        nextStartRow = Math.min(((dxx >> 4) * 10) + (dxx & 0x0f), pat.rows.length - 1);
        break;
      }
    }
  }
  return out;
}
