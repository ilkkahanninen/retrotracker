/**
 * Geometry constants and CSS-variable palette extraction shared by the
 * canvas-based pattern grids. Cell layout differs per format because
 * XM cells carry an extra volume-column field, so each format defines
 * its own sub-field x offsets via `CellLayout`.
 */

import { CHAR_W_CSS } from "./glyphAtlas";

export const ROW_HEIGHT = 19;
export const ROW_LABEL_W = 36;

/** Per-cell padding so column separators sit just outside the text. */
export const CELL_PAD_LEFT = 6;
export const CELL_PAD_RIGHT = 6;

export interface SubField {
  /** Internal name used by the cursor signal (`cursor.field`). */
  name: string;
  /** X offset (in CSS px) from the cell's content area, where this
   *  sub-field's text starts. */
  x: number;
  /** Width of the field's hit zone, in CSS px. */
  w: number;
}

export interface CellLayout {
  /** Display name for tooltips / debug. */
  format: "PT2" | "FT2";
  /** Full cell width in CSS px (text + horizontal padding + 1px border). */
  cellW: number;
  /** Sub-field hit zones, in order. The cell wrapper falls back to the
   *  first entry ("note") when a click misses any specific zone. */
  fields: ReadonlyArray<SubField>;
}

/** PT2 cell: NOTE (3) | SAMPLE_HI (1) SAMPLE_LO (1) | EFFECT (1) HI (1) LO (1).
 *  Total text = 3 + 2 + 3 = 8 chars + 2 separator gaps (1 char each) = 10 chars. */
export const PT_CELL_LAYOUT: CellLayout = (() => {
  const c = CHAR_W_CSS;
  let x = CELL_PAD_LEFT;
  const fields: SubField[] = [];
  fields.push({ name: "note", x, w: 3 * c });
  x += 3 * c + c; // 1-char gap
  fields.push({ name: "sampleHi", x, w: c });
  x += c;
  fields.push({ name: "sampleLo", x, w: c });
  x += c + c; // 1-char gap
  fields.push({ name: "effectCmd", x, w: c });
  x += c;
  fields.push({ name: "effectHi", x, w: c });
  x += c;
  fields.push({ name: "effectLo", x, w: c });
  const cellW = x + c + CELL_PAD_RIGHT;
  return { format: "PT2", cellW, fields };
})();

/** XM cell: NOTE (3) | INST_HI INST_LO | VOL_HI VOL_LO | EFFECT HI LO.
 *  Total text = 3 + 2 + 2 + 3 = 10 chars + 3 separator gaps = 13 chars. */
export const XM_CELL_LAYOUT: CellLayout = (() => {
  const c = CHAR_W_CSS;
  let x = CELL_PAD_LEFT;
  const fields: SubField[] = [];
  fields.push({ name: "note", x, w: 3 * c });
  x += 3 * c + c;
  fields.push({ name: "instHi", x, w: c });
  x += c;
  fields.push({ name: "instLo", x, w: c });
  x += c + c;
  fields.push({ name: "volHi", x, w: c });
  x += c;
  fields.push({ name: "volLo", x, w: c });
  x += c + c;
  fields.push({ name: "effectCmd", x, w: c });
  x += c;
  fields.push({ name: "effectHi", x, w: c });
  x += c;
  fields.push({ name: "effectLo", x, w: c });
  const cellW = x + c + CELL_PAD_RIGHT;
  return { format: "FT2", cellW, fields };
})();

/**
 * Palette colours pulled from the live theme so the canvas matches the
 * surrounding DOM. Read once on first draw and re-read whenever the
 * theme changes (settings: colorScheme).
 */
export interface GridPalette {
  bg: string;
  bgBeat: string;
  bgBar: string;
  bgCursor: string;
  bgActive: string;
  fg: string;
  muted: string;
  onAccent: string;
  gridLine: string;
  accent: string;
  selection: string;
  selectionBorder: string;
}

/** Read the named CSS custom property off `el`, with a fallback. */
function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Read the palette off an element in the live DOM. Pass any element
 * inside the app — `:root` works since the custom properties are
 * defined on `:root` in index.css.
 */
export function readGridPalette(el: Element): GridPalette {
  return {
    bg: cssVar(el, "--bg", "#14151a"),
    bgBeat: "rgba(255, 255, 255, 0.025)",
    bgBar: "rgba(94, 200, 255, 0.07)",
    bgCursor: cssVar(el, "--accent-dim", "#2a4f66"),
    bgActive: cssVar(el, "--accent", "#5ec8ff"),
    fg: cssVar(el, "--fg", "#d8dae5"),
    muted: cssVar(el, "--muted", "#8a8f9c"),
    onAccent: cssVar(el, "--text-on-accent", "#0a1118"),
    gridLine: cssVar(el, "--grid-line", "#2a2d38"),
    accent: cssVar(el, "--accent", "#5ec8ff"),
    selection: "rgba(94, 200, 255, 0.18)",
    selectionBorder: "rgba(94, 200, 255, 0.45)",
  };
}

/** Cell x in CSS px for `channelIndex`, given the runtime cell width. */
export function cellLeftX(channelIndex: number, cellW: number): number {
  return ROW_LABEL_W + channelIndex * cellW;
}

/** Total grid width (row label + N cells) in CSS px. */
export function gridWidth(channelCount: number, cellW: number): number {
  return ROW_LABEL_W + channelCount * cellW;
}

/**
 * Pick a per-channel cell width that fills the available viewport when
 * the natural layout would leave horizontal slack. Returns at least
 * `naturalCellW`, so wide patterns (many channels in a narrow viewport)
 * keep horizontal scrolling unchanged. Cells are centred on the runtime
 * width; padding lives on either side of the text.
 */
export function effectiveCellW(
  naturalCellW: number,
  channelCount: number,
  viewportWidth: number,
): number {
  if (channelCount <= 0 || viewportWidth <= 0) return naturalCellW;
  const fit = Math.floor((viewportWidth - ROW_LABEL_W) / channelCount);
  return Math.max(naturalCellW, fit);
}
