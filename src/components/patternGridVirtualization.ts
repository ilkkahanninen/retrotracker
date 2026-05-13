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
 * Keep the cursor row visible with minimal viewport disturbance.
 *
 *   1. Cursor on-screen + arrow movement toward the near edge —
 *      one-row nudge to keep `marginRows` past the cursor. Movement
 *      away from an edge, even when sitting in the margin band, is
 *      ignored.
 *   2. Cursor off-screen because the user *kept* moving the same
 *      direction (small delta) — same one-row nudge, snapping the
 *      cursor `marginRows` from the edge it crossed.
 *   3. Cursor off-screen because of a big jump (click, Page move,
 *      order-list nav) — centre it. Landing margin-rows from the
 *      edge would make the very next arrow keystroke scroll, which
 *      is the cascading-jerk we're trying to avoid.
 */
export function keepRowInView(
  scroller: HTMLElement,
  rowIndex: number,
  prevRowIndex: number,
  rowHeight: number = PATTERN_ROW_HEIGHT,
  marginRows: number = 2,
): void {
  const margin = rowHeight * marginRows;
  const rowTop = rowIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const viewHeight = scroller.clientHeight;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + viewHeight;
  const delta = rowIndex - prevRowIndex;
  const isJump = Math.abs(delta) > marginRows;

  if (rowTop < viewTop || rowBottom > viewBottom) {
    if (isJump) {
      scroller.scrollTop = Math.max(0, rowTop - (viewHeight - rowHeight) / 2);
    } else if (rowTop < viewTop) {
      scroller.scrollTop = Math.max(0, rowTop - margin);
    } else {
      scroller.scrollTop = rowBottom + margin - viewHeight;
    }
    return;
  }

  if (delta < 0 && rowTop - margin < viewTop) {
    scroller.scrollTop = Math.max(0, rowTop - margin);
  } else if (delta > 0 && rowBottom + margin > viewBottom) {
    scroller.scrollTop = rowBottom + margin - viewHeight;
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
