/**
 * Walk the XM order list and produce a single flat row list, matching the
 * shape of MOD's flatten so the editor's pattern grid can scroll
 * continuously through the whole song. Pattern-break (Dxx) and position-
 * jump (Bxx) handling mirrors MOD: Dxx truncates the rest of the current
 * pattern; row-target carries over to the next order.
 *
 * Phase 3 read-only viewer: jumps are intentionally NOT honoured for Bxx
 * (would create infinite views for songs that loop). For Dxx, both Bxx-
 * paired and standalone cases match MOD semantics.
 */

import type { XmNote, XmPattern, XmSong } from "./types";

export interface XmFlatRow {
  /** Index into song.orders. */
  order: number;
  /** Pattern-relative row index (used for the row label). */
  rowIndex: number;
  cells: XmNote[];
  /** True on the first row of a new pattern segment — the pattern grid
   *  draws an order marker above. */
  boundaryAbove: boolean;
}

const flatRowCache = new WeakMap<XmNote[], XmFlatRow>();

function getFlatRow(
  cells: XmNote[],
  order: number,
  rowIndex: number,
  boundaryAbove: boolean,
): XmFlatRow {
  const cached = flatRowCache.get(cells);
  if (
    cached &&
    cached.order === order &&
    cached.rowIndex === rowIndex &&
    cached.boundaryAbove === boundaryAbove
  ) {
    return cached;
  }
  const fr: XmFlatRow = { order, rowIndex, cells, boundaryAbove };
  flatRowCache.set(cells, fr);
  return fr;
}

/** XM effect codes for Dxx (PatternBreak) and Bxx (PositionJump). */
const FX_POSITION_JUMP = 0x0b;
const FX_PATTERN_BREAK = 0x0d;

export function flattenXmSong(song: XmSong): XmFlatRow[] {
  const out: XmFlatRow[] = [];
  let nextStartRow = 0;
  for (let o = 0; o < song.songLength; o++) {
    const patternIndex = song.orders[o] ?? 0;
    const pat: XmPattern | undefined = song.patterns[patternIndex];
    if (!pat) continue;
    const startRow = Math.min(nextStartRow, pat.rowCount - 1);
    nextStartRow = 0;
    let ignoreDxx = false;
    for (let r = startRow; r < pat.rowCount; r++) {
      const cells = pat.rows[r]!;
      out.push(getFlatRow(cells, o, r, r === startRow && o > 0));
      let dxx = -1;
      let hasBxx = false;
      for (const c of cells) {
        if (c.effect === FX_PATTERN_BREAK) dxx = c.effectParam;
        else if (c.effect === FX_POSITION_JUMP) hasBxx = true;
      }
      if (dxx >= 0) {
        if (hasBxx) {
          ignoreDxx = true;
        } else if (!ignoreDxx) {
          nextStartRow = Math.min(
            (dxx >> 4) * 10 + (dxx & 0x0f),
            pat.rowCount - 1,
          );
          break;
        }
      }
    }
  }
  return out;
}
