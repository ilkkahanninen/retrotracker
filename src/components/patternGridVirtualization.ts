/**
 * Pointer-and-scroll helpers shared by the canvas-rendered pattern
 * grids. Per-row visibility math used to live here for DOM
 * virtualization; canvas grids handle that inline in drawGrid*, so
 * only the scroll-into-view + flat-row scan helpers remain.
 *
 * `PATTERN_ROW_HEIGHT` is locked in CSS via `--pat-row-height`. Keep
 * the two in sync.
 */

export const PATTERN_ROW_HEIGHT = 19;

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
 * Nudge the scroller horizontally so the cell at `channelIndex` sits
 * within `marginChannels × cellWidth` of the viewport edges. Mirrors
 * `keepRowInView` for the horizontal axis — used to keep the cursor's
 * channel visible after keyboard moves that would otherwise carry it
 * past the right edge in many-channel XMs.
 */
export function keepChannelInView(
  scroller: HTMLElement,
  channelIndex: number,
  cellWidth: number,
  rowLabelWidth: number,
  marginChannels: number = 1,
): void {
  const margin = cellWidth * marginChannels;
  const left = rowLabelWidth + channelIndex * cellWidth;
  const right = left + cellWidth;
  const viewLeft = scroller.scrollLeft;
  const viewRight = viewLeft + scroller.clientWidth;
  if (left - margin < viewLeft) {
    scroller.scrollLeft = Math.max(0, left - margin);
  } else if (right + margin > viewRight) {
    scroller.scrollLeft = right + margin - scroller.clientWidth;
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
