import { describe, expect, it, vi } from "vitest";

import {
  CHAR_H_CSS,
  CHAR_W_CSS,
  GLYPH_COUNT,
  drawGlyph,
  drawString,
  glyphIndex,
  type GlyphAtlas,
  type GlyphPalette,
} from "~/components/grid/glyphAtlas";

const PALETTE: GlyphPalette = {
  fg: "#fff",
  muted: "#888",
  onAccent: "#000",
};

/** A fake atlas — drawGlyph only reads geometry, never the canvas pixels. */
function fakeAtlas(dpr: number): GlyphAtlas {
  return {
    canvas: {} as HTMLCanvasElement,
    dpr,
    charW: Math.ceil(CHAR_W_CSS * dpr),
    charH: Math.ceil(CHAR_H_CSS * dpr),
    palette: PALETTE,
  };
}

describe("glyphIndex", () => {
  it("returns 0 for space (start of printable ASCII)", () => {
    expect(glyphIndex(" ")).toBe(0);
  });

  it("returns sequential indices for ASCII digits", () => {
    const i0 = glyphIndex("0")!;
    expect(glyphIndex("1")).toBe(i0 + 1);
    expect(glyphIndex("9")).toBe(i0 + 9);
  });

  it("returns an index for the middle-dot glyph", () => {
    expect(typeof glyphIndex("·")).toBe("number");
  });

  it("returns undefined for characters not in the atlas", () => {
    expect(glyphIndex("é")).toBeUndefined(); // é
    expect(glyphIndex("ὠ0")).toBeUndefined();
  });
});

describe("drawGlyph / drawString geometry", () => {
  it("emits drawImage with source rect = (glyphIdx × charW, colorRow × charH)", () => {
    const atlas = fakeAtlas(2);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    const idx = glyphIndex("A")!;
    drawGlyph(ctx, atlas, "A", "fg", 100, 50);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const args = drawImage.mock.calls[0]!;
    // signature: (image, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(args[1]).toBe(idx * atlas.charW); // sx
    expect(args[2]).toBe(0); // sy — "fg" is the first colour row
    expect(args[3]).toBe(atlas.charW);
    expect(args[4]).toBe(atlas.charH);
    expect(args[5]).toBe(100); // dx
    expect(args[6]).toBe(50); // dy
    expect(args[7]).toBe(CHAR_W_CSS); // CSS-space draw width
    expect(args[8]).toBe(CHAR_H_CSS);
  });

  it("targets the second row of the atlas for muted glyphs", () => {
    const atlas = fakeAtlas(1);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    drawGlyph(ctx, atlas, "·", "muted", 0, 0);
    expect(drawImage.mock.calls[0]![2]).toBe(atlas.charH); // sy = 1 row × charH
  });

  it("targets the third row for on-accent glyphs", () => {
    const atlas = fakeAtlas(1);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    drawGlyph(ctx, atlas, "C", "onAccent", 0, 0);
    expect(drawImage.mock.calls[0]![2]).toBe(2 * atlas.charH);
  });

  it("silently skips characters not in the atlas", () => {
    const atlas = fakeAtlas(1);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    drawGlyph(ctx, atlas, "é", "fg", 0, 0);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("drawString steps x by CHAR_W_CSS for each glyph", () => {
    const atlas = fakeAtlas(1);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    drawString(ctx, atlas, "C-4", "fg", 10, 20);
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(drawImage.mock.calls[0]![5]).toBe(10);
    expect(drawImage.mock.calls[1]![5]).toBe(10 + CHAR_W_CSS);
    expect(drawImage.mock.calls[2]![5]).toBe(10 + 2 * CHAR_W_CSS);
  });
});

describe("GLYPH_COUNT", () => {
  it("covers printable ASCII (0x20..0x7E) + middle-dot", () => {
    // 0x7E - 0x20 + 1 = 95 printable ASCII chars, + middle-dot.
    expect(GLYPH_COUNT).toBe(96);
  });
});
