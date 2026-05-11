/**
 * Pure helpers shared by `PatternGrid` (PT) and `PatternGridXm` (FT2).
 * Both grids virtualize a tall absolute-positioned row tower the same
 * way; the only thing that differs is which signals drive cursor /
 * playhead positions and how cells are rendered. Each component still
 * owns its scroll/viewport signals and lifecycle — only the math moves
 * here.
 *
 * `PATTERN_ROW_HEIGHT` is locked in CSS via `--pat-row-height`. Keep
 * the two in sync.
 */

export const PATTERN_ROW_HEIGHT = 19;
/** Extra rows rendered above / below the viewport so quick scrolls
 *  don't reveal blank gaps before the next viewport tick. */
export const PATTERN_ROW_BUFFER = 12;

/**
 * Half-open `[start, end)` slice of `totalRows` that should be mounted
 * given the scroller's current `scrollTop` and `viewportHeight`. The
 * range is always clamped to `[0, totalRows]`.
 */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  rowHeight: number = PATTERN_ROW_HEIGHT,
  buffer: number = PATTERN_ROW_BUFFER,
): { start: number; end: number } {
  if (totalRows === 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const end = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + buffer,
  );
  return { start, end };
}

/** Linear scan: find the first index where `predicate` holds, or -1. */
export function flatIndexOf<T>(
  rows: T[],
  predicate: (r: T) => boolean,
): number {
  for (let i = 0; i < rows.length; i++) {
    if (predicate(rows[i]!)) return i;
  }
  return -1;
}

/**
 * Nudge the scroller so the row at `rowIndex` sits within
 * `marginRows × rowHeight` of the viewport edges. Used to keep the
 * edit cursor visible as it moves with the arrow keys.
 */
export function keepRowInView(
  scroller: HTMLElement,
  rowIndex: number,
  rowHeight: number = PATTERN_ROW_HEIGHT,
  marginRows: number = 2,
): void {
  const margin = rowHeight * marginRows;
  const top = rowIndex * rowHeight;
  const bottom = top + rowHeight;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (top - margin < viewTop) {
    scroller.scrollTop = Math.max(0, top - margin);
  } else if (bottom + margin > viewBottom) {
    scroller.scrollTop = bottom + margin - scroller.clientHeight;
  }
}

/**
 * Centre the row at `rowIndex` in the scroller. Used during playback
 * so the playhead stays in the middle of the viewport instead of
 * drifting toward an edge.
 */
export function centerRowInView(
  scroller: HTMLElement,
  rowIndex: number,
  rowHeight: number = PATTERN_ROW_HEIGHT,
): void {
  const top = rowIndex * rowHeight;
  scroller.scrollTop = top - scroller.clientHeight / 2 + rowHeight / 2;
}

/**
 * Snap the row at `rowIndex` to the top of the scroller. Used for
 * explicit jumps (order-list click, Insert slot) so the user sees the
 * rest of the destination pattern below.
 */
export function snapRowToTop(
  scroller: HTMLElement,
  rowIndex: number,
  rowHeight: number = PATTERN_ROW_HEIGHT,
): void {
  scroller.scrollTop = rowIndex * rowHeight;
}
