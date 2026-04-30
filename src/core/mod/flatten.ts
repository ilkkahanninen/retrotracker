import type { Note, Song } from './types';
import { Effect } from './format';

/** MOD defaults the replayer falls back to before any Fxx is hit. */
const DEFAULT_SPEED = 6;
const DEFAULT_TEMPO = 125;

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

/**
 * Walk the song from the start to (but not including) the given (order, row)
 * and return the speed and tempo that would be in effect at that position
 * — i.e. the most recent Fxx commands of each kind. Used when starting
 * playback mid-song so the song doesn't snap back to the MOD defaults.
 *
 * Within each row, the channels are processed left-to-right and the last
 * Fxx of each kind wins, matching the replayer.
 */
export function speedTempoAt(
  song: Song,
  order: number,
  row: number,
): { speed: number; tempo: number } {
  let speed = DEFAULT_SPEED;
  let tempo = DEFAULT_TEMPO;
  const flat = flattenSong(song);
  for (const fr of flat) {
    if (fr.order === order && fr.rowIndex === row) break;
    for (const cell of fr.cells) {
      if (cell.effect !== Effect.SetSpeed) continue;
      const p = cell.effectParam;
      if (p === 0) continue; // F00 = stop song; ignore for state-tracking
      if (p < 0x20) speed = p;
      else tempo = p;
    }
  }
  return { speed, tempo };
}
