/**
 * Canvas renderer for a single PT2 pattern cell. Decodes (period →
 * note name, sample byte → hex nibbles, effect byte → cmd char + hex
 * nibbles) and emits drawString calls. Each sub-field is exposed as
 * its own draw function so the grid renderer can re-paint just one
 * field for the cursor underline.
 *
 * Visual conventions mirror the prior DOM grid:
 *   - Empty note → "---"  (PT uses dashes; XM uses dots)
 *   - Empty sample/effect → "." per char (regular ASCII period)
 */

import { PERIOD_TABLE } from "../../core/mod/format";
import type { Note } from "../../core/mod/types";
import { drawString, type GlyphAtlas, type GlyphColor } from "./glyphAtlas";
import type { CellLayout } from "./gridGeometry";

const HEX_CHARS = "0123456789ABCDEF";

const NOTE_NAMES = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
] as const;

/** Period → display string. Matches pt2-clone's first-greater-or-equal
 *  scan in finetune 0 (the canonical period→note slot mapping). */
function periodToNoteName(period: number): string {
  if (period === 0) return "---";
  const row = PERIOD_TABLE[0]!;
  for (let i = 0; i < row.length; i++) {
    if (period >= row[i]!) {
      const oct = 1 + Math.floor(i / 12);
      return `${NOTE_NAMES[i % 12]}${oct}`;
    }
  }
  return "???";
}

export interface PtFieldOffsets {
  note: number;
  sampleHi: number;
  sampleLo: number;
  effectCmd: number;
  effectHi: number;
  effectLo: number;
}

export function makePtFieldOffsets(layout: CellLayout): PtFieldOffsets {
  const get = (name: string): number => {
    const f = layout.fields.find((x) => x.name === name);
    if (!f) throw new Error(`makePtFieldOffsets: missing "${name}"`);
    return f.x;
  };
  return {
    note: get("note"),
    sampleHi: get("sampleHi"),
    sampleLo: get("sampleLo"),
    effectCmd: get("effectCmd"),
    effectHi: get("effectHi"),
    effectLo: get("effectLo"),
  };
}

export interface CellTextColors {
  filled: GlyphColor;
  empty: GlyphColor;
}

/**
 * Draw a single named sub-field of a PT cell. `xLeft` is the cell's
 * left edge in CSS px; field x comes from `offsets`.
 *
 * `forceShowEffect` overrides the empty-collapse on the effect
 * sub-fields, mirroring the DOM grid's behaviour while the cursor is
 * on an effect column (otherwise typing arpeggio's first `0` looks
 * identical to an empty cell).
 */
export function drawCellPtField(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  note: Note,
  field: string,
  xLeft: number,
  y: number,
  offsets: PtFieldOffsets,
  colors: CellTextColors,
  forceShowEffect: boolean = false,
): void {
  switch (field) {
    case "note": {
      const empty = note.period === 0;
      drawString(
        ctx,
        atlas,
        periodToNoteName(note.period),
        empty ? colors.empty : colors.filled,
        xLeft + offsets.note,
        y,
      );
      return;
    }
    case "sampleHi": {
      const empty = note.sample === 0;
      drawString(
        ctx,
        atlas,
        empty ? "." : HEX_CHARS[(note.sample >>> 4) & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.sampleHi,
        y,
      );
      return;
    }
    case "sampleLo": {
      const empty = note.sample === 0;
      drawString(
        ctx,
        atlas,
        empty ? "." : HEX_CHARS[note.sample & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.sampleLo,
        y,
      );
      return;
    }
    case "effectCmd": {
      const empty =
        note.effect === 0 && note.effectParam === 0 && !forceShowEffect;
      drawString(
        ctx,
        atlas,
        empty ? "." : HEX_CHARS[note.effect & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectCmd,
        y,
      );
      return;
    }
    case "effectHi": {
      const empty =
        note.effect === 0 && note.effectParam === 0 && !forceShowEffect;
      drawString(
        ctx,
        atlas,
        empty ? "." : HEX_CHARS[(note.effectParam >>> 4) & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectHi,
        y,
      );
      return;
    }
    case "effectLo": {
      const empty =
        note.effect === 0 && note.effectParam === 0 && !forceShowEffect;
      drawString(
        ctx,
        atlas,
        empty ? "." : HEX_CHARS[note.effectParam & 0xf]!,
        empty ? colors.empty : colors.filled,
        xLeft + offsets.effectLo,
        y,
      );
      return;
    }
  }
}

/** Draw all sub-fields of a PT cell at (xLeft, y). */
export function drawCellPt(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  note: Note,
  xLeft: number,
  y: number,
  offsets: PtFieldOffsets,
  colors: CellTextColors,
  forceShowEffect: boolean,
): void {
  drawCellPtField(ctx, atlas, note, "note", xLeft, y, offsets, colors);
  drawCellPtField(ctx, atlas, note, "sampleHi", xLeft, y, offsets, colors);
  drawCellPtField(ctx, atlas, note, "sampleLo", xLeft, y, offsets, colors);
  drawCellPtField(
    ctx,
    atlas,
    note,
    "effectCmd",
    xLeft,
    y,
    offsets,
    colors,
    forceShowEffect,
  );
  drawCellPtField(
    ctx,
    atlas,
    note,
    "effectHi",
    xLeft,
    y,
    offsets,
    colors,
    forceShowEffect,
  );
  drawCellPtField(
    ctx,
    atlas,
    note,
    "effectLo",
    xLeft,
    y,
    offsets,
    colors,
    forceShowEffect,
  );
}
