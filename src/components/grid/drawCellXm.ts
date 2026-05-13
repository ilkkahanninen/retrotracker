/**
 * Canvas renderer for a single FT2 pattern cell. Decodes the note's
 * fields and emits drawString calls. Each sub-field is exposed as its
 * own draw function so the grid renderer can re-paint just one field
 * (used by the cursor overlay, which redraws the cursor sub-field's
 * text in on-accent colour after painting the accent rectangle).
 */

import {
  decodeVolumeColumn,
  effectChar,
  noteString,
} from "../../core/xm/effectLabels";
import type { XmNote } from "../../core/xm/types";
import { drawString, type GlyphAtlas, type GlyphColor } from "./glyphAtlas";
import type { CellLayout } from "./gridGeometry";

const HEX_CHARS = "0123456789ABCDEF";

/** Pre-built x offsets for each XM sub-field; saves a `.find` per cell. */
export interface XmFieldOffsets {
  note: number;
  instHi: number;
  instLo: number;
  volHi: number;
  volLo: number;
  effectCmd: number;
  effectHi: number;
  effectLo: number;
}

export function makeXmFieldOffsets(layout: CellLayout): XmFieldOffsets {
  const get = (name: string): number => {
    const f = layout.fields.find((x) => x.name === name);
    if (!f) throw new Error(`makeXmFieldOffsets: missing "${name}"`);
    return f.x;
  };
  return {
    note: get("note"),
    instHi: get("instHi"),
    instLo: get("instLo"),
    volHi: get("volHi"),
    volLo: get("volLo"),
    effectCmd: get("effectCmd"),
    effectHi: get("effectHi"),
    effectLo: get("effectLo"),
  };
}

export interface CellTextColors {
  /** Colour for non-empty content. "fg" outside the active row,
   *  "onAccent" inside. */
  filled: GlyphColor;
  /** Colour for empty placeholders. "muted" outside the active row,
   *  "onAccent" inside (matches the DOM grid's "half-opacity on
   *  accent" treatment closely enough). */
  empty: GlyphColor;
}

/**
 * Draw a single named sub-field at (xLeft, y). `xLeft` is the cell's
 * left edge in CSS px (NOT the field's x — the field x is read from
 * `offsets`).
 */
export function drawCellXmField(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  cell: XmNote,
  field: string,
  xLeft: number,
  y: number,
  offsets: XmFieldOffsets,
  colors: CellTextColors,
): void {
  switch (field) {
    case "note": {
      const empty = cell.note === 0;
      drawString(
        ctx,
        atlas,
        empty ? "..." : noteString(cell.note),
        empty ? colors.empty : colors.filled,
        xLeft + offsets.note,
        y,
      );
      return;
    }
    case "instHi": {
      const empty = cell.instrument === 0;
      drawString(
        ctx,
        atlas,
        empty ? "·" : HEX_CHARS[(cell.instrument >>> 4) & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.instHi,
        y,
      );
      return;
    }
    case "instLo": {
      const empty = cell.instrument === 0;
      drawString(
        ctx,
        atlas,
        empty ? "·" : HEX_CHARS[cell.instrument & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.instLo,
        y,
      );
      return;
    }
    case "volHi": {
      const v = decodeVolumeColumn(cell.volumeColumn);
      drawString(
        ctx,
        atlas,
        v ? v.kind : "·",
        v ? colors.filled : colors.empty,
        xLeft + offsets.volHi,
        y,
      );
      return;
    }
    case "volLo": {
      const v = decodeVolumeColumn(cell.volumeColumn);
      drawString(
        ctx,
        atlas,
        v ? HEX_CHARS[v.magnitude & 0xf]! : "·",
        v ? colors.filled : colors.empty,
        xLeft + offsets.volLo,
        y,
      );
      return;
    }
    case "effectCmd": {
      const empty = cell.effect === 0 && cell.effectParam === 0;
      drawString(
        ctx,
        atlas,
        empty ? "·" : effectChar(cell.effect),
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectCmd,
        y,
      );
      return;
    }
    case "effectHi": {
      const empty = cell.effect === 0 && cell.effectParam === 0;
      drawString(
        ctx,
        atlas,
        empty ? "·" : HEX_CHARS[(cell.effectParam >>> 4) & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectHi,
        y,
      );
      return;
    }
    case "effectLo": {
      const empty = cell.effect === 0 && cell.effectParam === 0;
      drawString(
        ctx,
        atlas,
        empty ? "·" : HEX_CHARS[cell.effectParam & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectLo,
        y,
      );
      return;
    }
  }
}

/** Draw all sub-fields of an XM cell at (xLeft, y). */
export function drawCellXm(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  cell: XmNote,
  xLeft: number,
  y: number,
  offsets: XmFieldOffsets,
  colors: CellTextColors,
): void {
  drawCellXmField(ctx, atlas, cell, "note", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "instHi", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "instLo", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "volHi", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "volLo", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "effectCmd", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "effectHi", xLeft, y, offsets, colors);
  drawCellXmField(ctx, atlas, cell, "effectLo", xLeft, y, offsets, colors);
}
