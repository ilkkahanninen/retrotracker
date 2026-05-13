/**
 * Shared clipboard / range primitives for pattern grids. PT and XM compose
 * this factory with their format-specific `emptyNote` factory, row/channel
 * bound accessors, and pattern reconstructor. The factory returns a tight
 * trio: `readSlice`, `clearRange`, `pasteSlice` — each pure with respect to
 * the input song (no mutation, returns a new song or `null`).
 */

export interface PatternRange {
  order: number;
  startRow: number;
  endRow: number;
  startChannel: number;
  endChannel: number;
}

export interface ClipboardOpsConfig<
  TNote extends object,
  TPattern extends { rows: TNote[][] },
  TSong extends { songLength: number; orders: number[]; patterns: TPattern[] },
> {
  /** Build a fresh empty cell — used when reading past the pattern end. */
  emptyNote: () => TNote;
  /** Row count for the given pattern. PT: fixed; XM: variable. */
  rowCountOf: (pattern: TPattern) => number;
  /** Channel count for the given song. PT: 4; XM: 2..32. */
  channelCountOf: (song: TSong) => number;
  /** Rebuild a pattern with replacement rows, preserving extra fields. */
  rebuildPattern: (oldPattern: TPattern, newRows: TNote[][]) => TPattern;
}

export interface ClipboardOps<
  TNote extends object,
  TSong extends { songLength: number; orders: number[] },
> {
  readSlice: (song: TSong, range: PatternRange) => TNote[][] | null;
  clearRange: (song: TSong, range: PatternRange) => TSong;
  pasteSlice: (
    song: TSong,
    slice: TNote[][],
    order: number,
    row: number,
    channel: number,
  ) => TSong;
}

export function makeClipboardOps<
  TNote extends object,
  TPattern extends { rows: TNote[][] },
  TSong extends { songLength: number; orders: number[]; patterns: TPattern[] },
>(cfg: ClipboardOpsConfig<TNote, TPattern, TSong>): ClipboardOps<TNote, TSong> {
  const { emptyNote, rowCountOf, channelCountOf, rebuildPattern } = cfg;

  function resolvePattern(
    song: TSong,
    order: number,
  ): { pattern: TPattern; patNum: number } | null {
    if (order < 0 || order >= song.songLength) return null;
    const patNum = song.orders[order];
    if (patNum === undefined) return null;
    const pattern = song.patterns[patNum];
    if (!pattern) return null;
    return { pattern, patNum };
  }

  function readSlice(song: TSong, range: PatternRange): TNote[][] | null {
    const resolved = resolvePattern(song, range.order);
    if (!resolved) return null;
    if (range.endRow < range.startRow) return null;
    if (range.endChannel < range.startChannel) return null;
    const { pattern } = resolved;
    const rows: TNote[][] = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      const row: TNote[] = [];
      for (let c = range.startChannel; c <= range.endChannel; c++) {
        const cell = pattern.rows[r]?.[c];
        row.push(cell ? { ...cell } : emptyNote());
      }
      rows.push(row);
    }
    return rows;
  }

  function clearRange(song: TSong, range: PatternRange): TSong {
    const resolved = resolvePattern(song, range.order);
    if (!resolved) return song;
    const { pattern, patNum } = resolved;
    const rowCount = rowCountOf(pattern);
    const channelCount = channelCountOf(song);
    const sR = Math.max(0, range.startRow);
    const eR = Math.min(rowCount - 1, range.endRow);
    const sC = Math.max(0, range.startChannel);
    const eC = Math.min(channelCount - 1, range.endChannel);
    if (eR < sR || eC < sC) return song;

    const newRows: TNote[][] = [...pattern.rows];
    for (let r = sR; r <= eR; r++) {
      const oldRow = newRows[r];
      if (!oldRow) continue;
      const newRow: TNote[] = [...oldRow];
      for (let c = sC; c <= eC; c++) newRow[c] = emptyNote();
      newRows[r] = newRow;
    }
    const newPatterns: TPattern[] = [...song.patterns];
    newPatterns[patNum] = rebuildPattern(pattern, newRows);
    return { ...song, patterns: newPatterns };
  }

  function pasteSlice(
    song: TSong,
    slice: TNote[][],
    order: number,
    row: number,
    channel: number,
  ): TSong {
    if (slice.length === 0) return song;
    const resolved = resolvePattern(song, order);
    if (!resolved) return song;
    const { pattern, patNum } = resolved;
    const rowCount = rowCountOf(pattern);
    const channelCount = channelCountOf(song);

    const newRows: TNote[][] = [...pattern.rows];
    let touched = false;
    for (let dr = 0; dr < slice.length; dr++) {
      const r = row + dr;
      if (r < 0 || r >= rowCount) continue;
      const sliceRow = slice[dr];
      if (!sliceRow) continue;
      const oldRow = newRows[r];
      if (!oldRow) continue;
      const newRow: TNote[] = [...oldRow];
      let rowChanged = false;
      for (let dc = 0; dc < sliceRow.length; dc++) {
        const c = channel + dc;
        if (c < 0 || c >= channelCount) continue;
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
    const newPatterns: TPattern[] = [...song.patterns];
    newPatterns[patNum] = rebuildPattern(pattern, newRows);
    return { ...song, patterns: newPatterns };
  }

  return { readSlice, clearRange, pasteSlice };
}
