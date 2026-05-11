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

import { walkOrders } from "../flatten";

import type { XmNote, XmSong } from "./types";

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

export function flattenXmSong(song: XmSong): XmFlatRow[] {
  const out: XmFlatRow[] = [];
  walkOrders(
    song,
    (pat) => pat.rows,
    (pat) => pat.rowCount,
    (cells, order, rowIndex, boundaryAbove) => {
      out.push(getFlatRow(cells, order, rowIndex, boundaryAbove));
    },
  );
  return out;
}

/**
 * Walk the song from (0, 0) to (order, row) and return the speed +
 * tempo that would be in effect on arrival. Mirrors PT's
 * `speedTempoAt` — used to seed the replayer when playback starts
 * mid-song so the user hears the same tempo as if the song had played
 * through normally.
 */
export function speedTempoAtXm(
  song: XmSong,
  order: number,
  row: number,
): { speed: number; tempo: number } {
  let speed = song.defaultTempo;
  let tempo = song.defaultBpm;
  const flat = flattenXmSong(song);
  for (const fr of flat) {
    if (fr.order === order && fr.rowIndex === row) break;
    for (const cell of fr.cells) {
      if (cell.effect !== 0x0f) continue;
      const p = cell.effectParam;
      if (p === 0) continue; // F00 = stop song; ignore for state-tracking
      if (p < 32) speed = p;
      else tempo = p;
    }
  }
  return { speed, tempo };
}
