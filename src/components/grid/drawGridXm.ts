/**
 * Top-level draw function for the FT2 canvas pattern grid. Takes a
 * snapshot of state (scroll position, flat rows, cursor, selection,
 * playhead) and paints the visible viewport. Caller is responsible
 * for calling it inside a `requestAnimationFrame` callback when
 * coalescing multiple state changes per frame.
 *
 * Painting order (back to front):
 *   1. Canvas background fill.
 *   2. Per-row background tint (beat / bar / cursor row / playhead row).
 *   3. Pattern-boundary horizontal dashed line above first row of any
 *      order ≥ 1.
 *   4. Row-number labels.
 *   5. Cell text via drawCellXm.
 *   6. Vertical channel separator gridlines.
 *   7. Selection rectangle (translucent fill).
 *   8. Cursor sub-field highlight: accent-coloured rect + re-paint of
 *      that one sub-field's text in on-accent colour.
 */

import type { XmFlatRow } from "../../core/xm/flatten";
import type { XmSong } from "../../core/xm/types";
import type { XmCursor } from "../../state/cursorXm";
import type { PatternSelection } from "../../state/selection";

import {
  drawCellXm,
  drawCellXmField,
  type CellTextColors,
  type XmFieldOffsets,
} from "./drawCellXm";
import { drawString, type GlyphAtlas, type GlyphColor } from "./glyphAtlas";
import {
  cellLeftX,
  ROW_HEIGHT,
  ROW_LABEL_W,
  type CellLayout,
  type GridPalette,
} from "./gridGeometry";

export interface DrawGridXmParams {
  atlas: GlyphAtlas;
  palette: GridPalette;
  song: XmSong;
  flat: XmFlatRow[];
  layout: CellLayout;
  /** Pre-computed sub-field offsets (caller caches it once per layout). */
  offsets: XmFieldOffsets;
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Rows per beat / beats per bar for tinting. 0 disables tinting. */
  rowsPerBeat: number;
  beatsPerBar: number;
  /** Cursor in (order, row, channel, field) form, or null when hidden
   *  (active playback). */
  cursor: XmCursor | null;
  /** Index of the cursor row inside `flat`, or -1 when hidden. */
  cursorFlatIndex: number;
  /** Active selection rectangle, or null. */
  selection: PatternSelection | null;
  /** Index of the playhead row inside `flat`, or -1 when not playing. */
  activeFlatIndex: number;
}

const ROW_LABEL_X = 6; // CSS px padding from the left of the row-label column.

export function drawGridXm(
  ctx: CanvasRenderingContext2D,
  p: DrawGridXmParams,
): void {
  const {
    atlas,
    palette,
    song,
    flat,
    layout,
    offsets,
    scrollLeft,
    scrollTop,
    viewportWidth,
    viewportHeight,
    rowsPerBeat,
    beatsPerBar,
    cursor,
    cursorFlatIndex,
    selection,
    activeFlatIndex,
  } = p;

  // 1. Background.
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  if (flat.length === 0 || song.channelCount === 0) return;

  const cellW = layout.cellW;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const lastRow = Math.min(
    flat.length - 1,
    Math.floor((scrollTop + viewportHeight - 1) / ROW_HEIGHT),
  );
  const firstCh = Math.max(0, Math.floor((scrollLeft - ROW_LABEL_W) / cellW));
  const lastCh = Math.min(
    song.channelCount - 1,
    Math.floor((scrollLeft + viewportWidth - ROW_LABEL_W - 1) / cellW),
  );

  // Content → viewport coords.
  const toX = (contentX: number) => contentX - scrollLeft;
  const toY = (contentY: number) => contentY - scrollTop;

  // 2 & 3 & 4. Row backgrounds, boundaries, labels.
  for (let r = firstRow; r <= lastRow; r++) {
    const item = flat[r]!;
    const isBeat = rowsPerBeat > 0 && item.rowIndex % rowsPerBeat === 0;
    const isBar =
      rowsPerBeat * beatsPerBar > 0 &&
      item.rowIndex % (rowsPerBeat * beatsPerBar) === 0;
    const isActive = activeFlatIndex === r;
    const isCursorRow = !isActive && cursorFlatIndex === r && cursor !== null;
    const rowY = toY(r * ROW_HEIGHT);

    // Row background — last-wins precedence: active > cursor > bar > beat.
    let rowBg: string | null = null;
    if (isActive) rowBg = palette.bgActive;
    else if (isCursorRow) rowBg = palette.bgCursor;
    else if (isBar) rowBg = palette.bgBar;
    else if (isBeat) rowBg = palette.bgBeat;
    if (rowBg) {
      ctx.fillStyle = rowBg;
      ctx.fillRect(0, rowY, viewportWidth, ROW_HEIGHT);
    }

    // Bar-row 2px accent stripe (mirrors PT2 CSS box-shadow inset).
    if (isBar && !isActive) {
      ctx.fillStyle = palette.accent;
      ctx.fillRect(0, rowY, 2, ROW_HEIGHT);
    }

    // Pattern boundary — short dashes across the row's top edge.
    if (item.boundaryAbove) {
      ctx.fillStyle = palette.muted;
      const dashLen = 4;
      const gapLen = 4;
      for (let x = 0; x < viewportWidth; x += dashLen + gapLen) {
        ctx.fillRect(x, rowY, dashLen, 1);
      }
    }

    // Row label — 2 hex chars left-aligned in the label column.
    const labelText = item.rowIndex.toString(16).toUpperCase().padStart(2, "0");
    const labelColor: GlyphColor = isActive ? "onAccent" : "muted";
    drawString(ctx, atlas, labelText, labelColor, toX(ROW_LABEL_X), rowY);
  }

  // 5. Cell text.
  for (let r = firstRow; r <= lastRow; r++) {
    const item = flat[r]!;
    const rowY = toY(r * ROW_HEIGHT);
    const isActive = activeFlatIndex === r;
    const colors: CellTextColors = {
      filled: isActive ? "onAccent" : "fg",
      empty: isActive ? "onAccent" : "muted",
    };
    for (let c = firstCh; c <= lastCh; c++) {
      const cell = item.cells[c];
      if (!cell) continue;
      const xLeft = toX(cellLeftX(layout, c));
      drawCellXm(ctx, atlas, cell, xLeft, rowY, offsets, colors);
    }
  }

  // 6. Vertical channel separators (1px lines along each cell's left
  // edge). Skipped over the row-label column.
  ctx.fillStyle = palette.gridLine;
  for (let c = firstCh; c <= lastCh + 1; c++) {
    const x = toX(cellLeftX(layout, c));
    if (x < ROW_LABEL_W - scrollLeft) continue;
    ctx.fillRect(x, 0, 1, viewportHeight);
  }

  // 7. Selection rectangle. The selection is keyed on (order, row
  // range, channel range); flatten folds in Dxx truncations so we
  // walk `flat` to find the corresponding flat-row range.
  if (selection) {
    let selFirstR = -1;
    let selLastR = -1;
    for (let r = 0; r < flat.length; r++) {
      const it = flat[r]!;
      if (it.order !== selection.order) continue;
      if (it.rowIndex < selection.startRow) continue;
      if (it.rowIndex > selection.endRow) break;
      if (selFirstR < 0) selFirstR = r;
      selLastR = r;
    }
    if (selFirstR >= 0) {
      const x0 = toX(cellLeftX(layout, selection.startChannel));
      const x1 = toX(cellLeftX(layout, selection.endChannel + 1));
      const y0 = toY(selFirstR * ROW_HEIGHT);
      const y1 = toY((selLastR + 1) * ROW_HEIGHT);
      ctx.fillStyle = palette.selection;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  // 8. Cursor sub-field highlight.
  if (cursor && cursorFlatIndex >= firstRow && cursorFlatIndex <= lastRow) {
    if (cursor.channel >= firstCh && cursor.channel <= lastCh) {
      const field = layout.fields.find((f) => f.name === cursor.field);
      if (field) {
        const xLeft = toX(cellLeftX(layout, cursor.channel));
        const y = toY(cursorFlatIndex * ROW_HEIGHT);
        const fieldX = xLeft + field.x;
        ctx.fillStyle = palette.accent;
        ctx.fillRect(fieldX - 1, y, field.w + 2, ROW_HEIGHT);
        const cell = flat[cursorFlatIndex]!.cells[cursor.channel];
        if (cell) {
          drawCellXmField(ctx, atlas, cell, cursor.field, xLeft, y, offsets, {
            filled: "onAccent",
            empty: "onAccent",
          });
        }
      }
    }
  }
}
