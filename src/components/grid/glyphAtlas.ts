/**
 * Pre-rasterised glyph atlas for the canvas-based pattern grids. Both
 * PT and FT2 modes draw Departure Mono at 11px / 16px line height; the
 * full set of characters that ever appears in a cell is small (~95
 * printable ASCII plus `·`). Building one atlas per (color, DPR) means
 * the per-cell drawing turns into a handful of `drawImage` calls,
 * which is an order of magnitude cheaper than `fillText` on most
 * platforms.
 *
 * The atlas is multi-row, one row per palette colour we need
 * (foreground, muted, on-accent). Each glyph occupies a fixed
 * (CHAR_W × CHAR_H) cell; lookup is by character → index, then
 * `drawImage` with the column / row offsets.
 *
 * Atlas is rebuilt lazily on first draw and whenever DPR or the
 * palette changes.
 */

/** Grid font. Departure Mono is a pixel font drawn on an 11px em — keep the
 *  size at 11 (or an integer multiple) or the glyphs land off the pixel grid.
 *  The family must match `--font-mono` in index.css. */
export const GRID_FONT_PX = 11;
export const GRID_FONT_FAMILY =
  '"Departure Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export const CHAR_W_CSS = 7; // Departure Mono advance at 11px is exactly 7px.
export const CHAR_H_CSS = 16; // matches CSS var --pat-row-height.
/** Baseline offset inside a cell: the 8px cap height is centred in the 16px
 *  row (4px above), leaving room for the 2px descenders below. */
const BASELINE_CSS = 12;

/** Every glyph the grid can possibly render. Printable ASCII + `·`. */
const GLYPHS = (() => {
  const chars: string[] = [];
  for (let cp = 0x20; cp <= 0x7e; cp++) chars.push(String.fromCharCode(cp));
  chars.push("·");
  return chars;
})();

/** Fast lookup: charCode (or middle-dot) → column index. */
const GLYPH_INDEX: ReadonlyMap<string, number> = new Map(
  GLYPHS.map((c, i) => [c, i]),
);

export const GLYPH_COUNT = GLYPHS.length;

/** Palette colours baked into the atlas. Each becomes one row. */
export type GlyphColor = "fg" | "muted" | "onAccent";
const COLOR_ROWS: ReadonlyArray<GlyphColor> = ["fg", "muted", "onAccent"];

export interface GlyphPalette {
  fg: string;
  muted: string;
  onAccent: string;
}

export interface GlyphAtlas {
  /** The off-screen canvas the atlas was rasterised into. */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Device-pixel-ratio the atlas was built at. */
  dpr: number;
  /** Char advance, in DEVICE pixels. */
  charW: number;
  /** Line height, in DEVICE pixels. */
  charH: number;
  /** Palette baked into the atlas (used to detect cache invalidation). */
  palette: GlyphPalette;
}

function makeOffscreen(
  w: number,
  h: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Build the atlas at the given DPR + palette. ~25ms first call;
 * subsequent calls cached by (dpr, palette) inequality at the caller.
 */
export function buildGlyphAtlas(
  dpr: number,
  palette: GlyphPalette,
): GlyphAtlas {
  const charW = Math.ceil(CHAR_W_CSS * dpr);
  const charH = Math.ceil(CHAR_H_CSS * dpr);
  const atlasW = charW * GLYPH_COUNT;
  const atlasH = charH * COLOR_ROWS.length;
  const canvas = makeOffscreen(atlasW, atlasH);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("glyphAtlas: 2D context unavailable");

  // Same family / size as the CSS so the canvas matches the DOM header.
  ctx.font = `${Math.round(GRID_FONT_PX * dpr)}px ${GRID_FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";

  for (let r = 0; r < COLOR_ROWS.length; r++) {
    const color = palette[COLOR_ROWS[r]!];
    ctx.fillStyle = color;
    for (let g = 0; g < GLYPHS.length; g++) {
      const ch = GLYPHS[g]!;
      const x = g * charW;
      const yBaseline = r * charH + Math.round(BASELINE_CSS * dpr);
      ctx.fillText(ch, x, yBaseline);
    }
  }

  return { canvas, dpr, charW, charH, palette };
}

/** Returns `undefined` for characters not in the atlas. */
export function glyphIndex(char: string): number | undefined {
  return GLYPH_INDEX.get(char);
}

/**
 * Draw a single glyph onto `ctx` at the given DEVICE-pixel position.
 * Treats unknown characters as a no-op so callers don't have to
 * filter. Caller is responsible for `ctx.setTransform(dpr, …)` matching
 * the atlas DPR.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  char: string,
  color: GlyphColor,
  dxCss: number,
  dyCss: number,
): void {
  const idx = GLYPH_INDEX.get(char);
  if (idx === undefined) return;
  const colorRow = COLOR_ROWS.indexOf(color);
  ctx.drawImage(
    atlas.canvas as CanvasImageSource,
    idx * atlas.charW,
    colorRow * atlas.charH,
    atlas.charW,
    atlas.charH,
    dxCss,
    dyCss,
    CHAR_W_CSS,
    CHAR_H_CSS,
  );
}

/**
 * Draw a string by stepping through each char and emitting a
 * `drawImage`. Internally hot — keep allocation-free.
 */
export function drawString(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  s: string,
  color: GlyphColor,
  dxCss: number,
  dyCss: number,
): void {
  for (let i = 0; i < s.length; i++) {
    drawGlyph(ctx, atlas, s[i]!, color, dxCss + i * CHAR_W_CSS, dyCss);
  }
}

/**
 * Run `cb` once the grid webfont is usable. `document.fonts.ready` alone can
 * resolve before a not-yet-requested face has loaded, which would leave the
 * atlas baked with the fallback family — so the face is requested explicitly.
 * No-op where the Font Loading API is missing (jsdom).
 */
export function whenGridFontReady(cb: () => void): void {
  if (typeof document === "undefined" || !document.fonts) return;
  const fonts = document.fonts;
  fonts
    .load(`${GRID_FONT_PX}px ${GRID_FONT_FAMILY}`)
    .catch(() => undefined)
    .then(() => fonts.ready)
    .then(cb);
}
