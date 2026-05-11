/**
 * Pre-rasterised glyph atlas for the canvas-based pattern grids. Both
 * PT and FT2 modes draw monospace text at 13px / 19px line height; the
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

export const CHAR_W_CSS = 8; // ui-monospace 13px ≈ 7.8px advance; round up.
export const CHAR_H_CSS = 19; // matches CSS var --pat-row-height.

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

  // Font must be set BEFORE measureText for accurate width. We use the
  // same family / size as the CSS so visually the canvas matches DOM.
  ctx.font = `${Math.round(13 * dpr)}px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.textBaseline = "alphabetic";

  for (let r = 0; r < COLOR_ROWS.length; r++) {
    const color = palette[COLOR_ROWS[r]!];
    ctx.fillStyle = color;
    for (let g = 0; g < GLYPHS.length; g++) {
      const ch = GLYPHS[g]!;
      // Glyph baseline sits 4/5 of the way down — empirically tuned
      // for ui-monospace at 13/19. Centre-aligning by descent would
      // need per-font metrics; this is close enough.
      const x = g * charW;
      const yBaseline = r * charH + Math.round(charH * 0.78);
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
