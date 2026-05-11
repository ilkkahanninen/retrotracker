/**
 * Pointer → grid coordinate math, shared by both canvas grids. Pure
 * functions so they can be unit-tested without a DOM.
 */

import type { CellLayout } from "./gridGeometry";
import { ROW_HEIGHT, ROW_LABEL_W } from "./gridGeometry";

export interface GridHit {
  /** Row index in the flat row list (0-based). */
  flatRowIndex: number;
  channel: number;
  /** Sub-field hit zone name from the layout, or the layout's first
   *  field ("note") when the click lands in the cell's padding. */
  field: string;
}

/**
 * Resolve a viewport-local pointer position to (row, channel, field).
 *
 * - `xCss` / `yCss` are CSS pixels relative to the canvas's top-left.
 * - `scrollLeft` / `scrollTop` are the scroll container's offsets.
 * - Clicks on the row-label column (x < ROW_LABEL_W) return `null` so
 *   the caller can ignore them.
 * - Clicks past the last channel or past the last flat row return null.
 */
export function hitTest(
  xCss: number,
  yCss: number,
  scrollLeft: number,
  scrollTop: number,
  layout: CellLayout,
  channelCount: number,
  flatRowCount: number,
): GridHit | null {
  const x = xCss + scrollLeft;
  const y = yCss + scrollTop;
  if (x < ROW_LABEL_W) return null;
  if (y < 0) return null;
  const flatRowIndex = Math.floor(y / ROW_HEIGHT);
  if (flatRowIndex < 0 || flatRowIndex >= flatRowCount) return null;
  const cellsX = x - ROW_LABEL_W;
  const channel = Math.floor(cellsX / layout.cellW);
  if (channel < 0 || channel >= channelCount) return null;
  const inCellX = cellsX - channel * layout.cellW;
  // Find the inner-most sub-field hit. Clicks on padding land on the
  // first field ("note") — mirrors the DOM grid's fallback behaviour.
  let field = layout.fields[0]!.name;
  for (const f of layout.fields) {
    if (inCellX >= f.x && inCellX < f.x + f.w) {
      field = f.name;
      break;
    }
  }
  return { flatRowIndex, channel, field };
}
