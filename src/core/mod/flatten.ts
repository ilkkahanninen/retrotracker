import type { Note, Song } from "./types";
import { Effect } from "./format";

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

// Cache keyed on a row's `Note[]` reference so unchanged rows yield the same
// FlatRow object across calls. setCell preserves cells refs for untouched
// rows, so editing one cell rebuilds exactly one FlatRow and Solid's <For>
// can skip reconciling the other ~255.
const flatRowCache = new WeakMap<Note[], FlatRow>();

function getFlatRow(
  cells: Note[],
  order: number,
  rowIndex: number,
  boundaryAbove: boolean,
): FlatRow {
  const cached = flatRowCache.get(cells);
  if (
    cached &&
    cached.order === order &&
    cached.rowIndex === rowIndex &&
    cached.boundaryAbove === boundaryAbove
  ) {
    return cached;
  }
  const fr: FlatRow = { order, rowIndex, cells, boundaryAbove };
  flatRowCache.set(cells, fr);
  return fr;
}

/**
 * Walk the order list and produce a single flat row list.
 *
 * Dxx (Pattern Break) truncates the rest of the current pattern; the next
 * order resumes at the Dxx-target row. Bxx and pattern-loop are deliberately
 * NOT honored here — they would create infinite views for songs that loop.
 *
 * If row contains both Bxx and Dxx do not try to truncate this pattern or
 * some tracker-fu techniques, like walking the pattern in reverse order,
 * break the pattern grid view.
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
    let ignoreDxx = false;
    for (let r = startRow; r < pat.rows.length; r++) {
      const cells = pat.rows[r]!;
      out.push(getFlatRow(cells, o, r, r === startRow && o > 0));
      let dxx = -1;
      let hasBxx = false;
      for (const c of cells) {
        if (c.effect === Effect.PatternBreak) dxx = c.effectParam;
        else if (c.effect === Effect.PositionJump) hasBxx = true;
      }
      if (dxx >= 0) {
        if (hasBxx) {
          ignoreDxx = true;
        } else if (!ignoreDxx) {
          nextStartRow = Math.min(
            (dxx >> 4) * 10 + (dxx & 0x0f),
            pat.rows.length - 1,
          );
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Range of visible (i.e., not Dxx-truncated) rows in the given order. `first`
 * accounts for an inbound Dxx-target row from a preceding pattern; `last`
 * accounts for the truncating Dxx within this pattern. Returns null when the
 * order has no visible rows at all (defensive — shouldn't happen for a
 * well-formed song with `songLength > 0`).
 *
 * Used by selection-extend keybinds to clamp shift-arrow / shift-page steps
 * to the visible grid; without it, selections leak into rows the user can't
 * see and never edits.
 */
export function visibleRowRangeForOrder(
  song: Song,
  order: number,
): { first: number; last: number } | null {
  const flat = flattenSong(song);
  let first = -1;
  let last = -1;
  for (const fr of flat) {
    if (fr.order !== order) continue;
    if (first < 0) first = fr.rowIndex;
    last = fr.rowIndex;
  }
  if (first < 0) return null;
  return { first, last };
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
