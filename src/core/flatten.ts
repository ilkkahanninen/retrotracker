/**
 * Shared order-list walker for pattern grids. Both formats produce a
 * flat row list by visiting patterns in `song.orders` order, handling
 * Dxx (Pattern Break, 0x0d) and Bxx (Position Jump, 0x0b) the same way:
 * Dxx truncates the current pattern and the next order resumes at the
 * Dxx target row; Bxx is honoured for "infinite loop" suppression only
 * (a row carrying both Bxx and Dxx ignores the Dxx). The numeric codes
 * are identical between MOD and XM, so the walker hardcodes them.
 *
 * Per-format `flatten` modules supply the row accessors and own their
 * `FlatRow` cache.
 */

const FX_POSITION_JUMP = 0x0b;
const FX_PATTERN_BREAK = 0x0d;

interface EffectCell {
  effect: number;
  effectParam: number;
}

/**
 * Visit each playable row of `song` in order. For each row, `emit` is
 * called with the row's cells, the order index, the in-pattern row
 * index, and a `boundaryAbove` flag (true on the first row of any order
 * after the first — used by UI to draw a divider).
 *
 * Pattern resolution falls back to pattern 0 when `orders[o]` is
 * undefined; orders whose pattern doesn't exist are skipped entirely.
 *
 * Note on generics: TCell is inferred via `rowsOf`'s return type rather
 * than through a constraint on TPattern — TypeScript can't deduce a
 * type parameter that only appears in a `extends` clause.
 */
export function walkOrders<TPattern, TCell extends EffectCell>(
  song: {
    songLength: number;
    orders: number[];
    patterns: TPattern[];
  },
  rowsOf: (pattern: TPattern) => TCell[][],
  rowCountOf: (pattern: TPattern) => number,
  emit: (
    cells: TCell[],
    order: number,
    rowIndex: number,
    boundaryAbove: boolean,
  ) => void,
): void {
  let nextStartRow = 0;
  for (let o = 0; o < song.songLength; o++) {
    const patternIndex = song.orders[o] ?? 0;
    const pat = song.patterns[patternIndex];
    if (!pat) continue;
    const rowCount = rowCountOf(pat);
    if (rowCount <= 0) continue;
    const rows = rowsOf(pat);
    const startRow = Math.min(nextStartRow, rowCount - 1);
    nextStartRow = 0;
    let ignoreDxx = false;
    for (let r = startRow; r < rowCount; r++) {
      const cells = rows[r]!;
      emit(cells, o, r, r === startRow && o > 0);
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
          nextStartRow = Math.min((dxx >> 4) * 10 + (dxx & 0x0f), rowCount - 1);
          break;
        }
      }
    }
  }
}
