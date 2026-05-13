/**
 * Top-level draw function for the PT2 canvas pattern grid. Structurally
 * mirrors `drawGridXm` — the only differences are the cell renderer
 * (`drawCellPt` decodes period→note name and has no volume column),
 * the cursor type (`Cursor` instead of `XmCursor`), and the
 * forceShowEffect treatment when the cursor sits on an effect field.
 */

import type { Cursor } from "../../state/cursor";
import type { FlatRow } from "../../core/mod/flatten";
import type { ModSong } from "../../core/mod/types";
import type { PatternSelection } from "../../state/selection";

import {
  drawCellPt,
  drawCellPtField,
  type CellTextColors,
  type PtFieldOffsets,
} from "./drawCellPt";
import { drawString, type GlyphAtlas, type GlyphColor } from "./glyphAtlas";
import {
  cellLeftX,
  ROW_HEIGHT,
  ROW_LABEL_W,
  type CellLayout,
  type GridPalette,
} from "./gridGeometry";

export interface DrawGridPtParams {
  atlas: GlyphAtlas;
  palette: GridPalette;
  song: ModSong;
  flat: FlatRow[];
  layout: CellLayout;
  offsets: PtFieldOffsets;
  /** Runtime per-channel cell width. Equals `layout.cellW` when the
   *  pattern overflows the viewport; expanded otherwise. Cell text is
   *  centred within this width. */
  cellW: number;
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  rowsPerBeat: number;
  beatsPerBar: number;
  /** Number of channels in the song. PT2 is fixed at 4 but we accept it
   *  explicitly so the renderer doesn't depend on a constant. */
  channelCount: number;
  cursor: Cursor | null;
  cursorFlatIndex: number;
  selection: PatternSelection | null;
  activeFlatIndex: number;
}

const ROW_LABEL_X = 6;

export function drawGridPt(
  ctx: CanvasRenderingContext2D,
  p: DrawGridPtParams,
): void {
  const {
    atlas,
    palette,
    flat,
    layout,
    offsets,
    cellW,
    scrollLeft,
    scrollTop,
    viewportWidth,
    viewportHeight,
    rowsPerBeat,
    beatsPerBar,
    channelCount,
    cursor,
    cursorFlatIndex,
    selection,
    activeFlatIndex,
  } = p;

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  if (flat.length === 0 || channelCount === 0) return;

  const centerOffset = (cellW - layout.cellW) / 2;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const lastRow = Math.min(
    flat.length - 1,
    Math.floor((scrollTop + viewportHeight - 1) / ROW_HEIGHT),
  );
  const firstCh = Math.max(0, Math.floor((scrollLeft - ROW_LABEL_W) / cellW));
  const lastCh = Math.min(
    channelCount - 1,
    Math.floor((scrollLeft + viewportWidth - ROW_LABEL_W - 1) / cellW),
  );

  const toX = (contentX: number) => contentX - scrollLeft;
  const toY = (contentY: number) => contentY - scrollTop;

  // Row backgrounds + boundaries + labels.
  for (let r = firstRow; r <= lastRow; r++) {
    const item = flat[r]!;
    const isBeat = rowsPerBeat > 0 && item.rowIndex % rowsPerBeat === 0;
    const isBar =
      rowsPerBeat * beatsPerBar > 0 &&
      item.rowIndex % (rowsPerBeat * beatsPerBar) === 0;
    const isActive = activeFlatIndex === r;
    const isCursorRow = !isActive && cursorFlatIndex === r && cursor !== null;
    const rowY = toY(r * ROW_HEIGHT);

    let rowBg: string | null = null;
    if (isActive) rowBg = palette.bgActive;
    else if (isCursorRow) rowBg = palette.bgCursor;
    else if (isBar) rowBg = palette.bgBar;
    else if (isBeat) rowBg = palette.bgBeat;
    if (rowBg) {
      ctx.fillStyle = rowBg;
      ctx.fillRect(0, rowY, viewportWidth, ROW_HEIGHT);
    }

    if (isBar && !isActive) {
      ctx.fillStyle = palette.accent;
      ctx.fillRect(0, rowY, 2, ROW_HEIGHT);
    }

    if (item.boundaryAbove) {
      ctx.fillStyle = palette.muted;
      const dashLen = 4;
      const gapLen = 4;
      for (let x = 0; x < viewportWidth; x += dashLen + gapLen) {
        ctx.fillRect(x, rowY, dashLen, 1);
      }
    }

    const labelText = item.rowIndex.toString(16).toUpperCase().padStart(2, "0");
    const labelColor: GlyphColor = isActive ? "onAccent" : "muted";
    drawString(ctx, atlas, labelText, labelColor, toX(ROW_LABEL_X), rowY);
  }

  // Cell text. Cursor-on-effect forces digits to render even when both
  // nibbles are zero — same convention as the DOM grid.
  for (let r = firstRow; r <= lastRow; r++) {
    const item = flat[r]!;
    const rowY = toY(r * ROW_HEIGHT);
    const isActive = activeFlatIndex === r;
    const colors: CellTextColors = {
      filled: isActive ? "onAccent" : "fg",
      empty: isActive ? "onAccent" : "muted",
    };
    const cursorHereRow =
      cursor !== null && cursorFlatIndex === r ? cursor : null;
    for (let c = firstCh; c <= lastCh; c++) {
      const note = item.cells[c];
      if (!note) continue;
      const xLeft = toX(cellLeftX(c, cellW)) + centerOffset;
      const cursorOnEffect =
        cursorHereRow !== null &&
        cursorHereRow.channel === c &&
        (cursorHereRow.field === "effectCmd" ||
          cursorHereRow.field === "effectHi" ||
          cursorHereRow.field === "effectLo");
      drawCellPt(
        ctx,
        atlas,
        note,
        xLeft,
        rowY,
        offsets,
        colors,
        cursorOnEffect,
      );
    }
  }

  // Vertical channel separators.
  ctx.fillStyle = palette.gridLine;
  for (let c = firstCh; c <= lastCh + 1; c++) {
    const x = toX(cellLeftX(c, cellW));
    if (x < ROW_LABEL_W - scrollLeft) continue;
    ctx.fillRect(x, 0, 1, viewportHeight);
  }

  // Selection rectangle.
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
      const x0 = toX(cellLeftX(selection.startChannel, cellW));
      const x1 = toX(cellLeftX(selection.endChannel + 1, cellW));
      const y0 = toY(selFirstR * ROW_HEIGHT);
      const y1 = toY((selLastR + 1) * ROW_HEIGHT);
      ctx.fillStyle = palette.selection;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  // Cursor sub-field highlight.
  if (cursor && cursorFlatIndex >= firstRow && cursorFlatIndex <= lastRow) {
    if (cursor.channel >= firstCh && cursor.channel <= lastCh) {
      const field = layout.fields.find((f) => f.name === cursor.field);
      if (field) {
        const xLeft = toX(cellLeftX(cursor.channel, cellW)) + centerOffset;
        const y = toY(cursorFlatIndex * ROW_HEIGHT);
        const fieldX = xLeft + field.x;
        ctx.fillStyle = palette.accent;
        ctx.fillRect(fieldX - 1, y, field.w + 2, ROW_HEIGHT);
        const note = flat[cursorFlatIndex]!.cells[cursor.channel];
        if (note) {
          drawCellPtField(
            ctx,
            atlas,
            note,
            cursor.field,
            xLeft,
            y,
            offsets,
            { filled: "onAccent", empty: "onAccent" },
            // Force-show: the cursor field always wants to be readable.
            true,
          );
        }
      }
    }
  }
}
