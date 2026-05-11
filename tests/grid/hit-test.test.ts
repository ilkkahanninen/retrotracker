import { describe, expect, it } from "vitest";

import {
  PT_CELL_LAYOUT,
  ROW_HEIGHT,
  ROW_LABEL_W,
  XM_CELL_LAYOUT,
} from "~/components/grid/gridGeometry";
import { hitTest } from "~/components/grid/hitTest";

describe("hitTest", () => {
  it("returns null for clicks on the row-label column", () => {
    expect(hitTest(5, 0, 0, 0, XM_CELL_LAYOUT, 8, 64)).toBeNull();
    expect(hitTest(ROW_LABEL_W - 1, 0, 0, 0, XM_CELL_LAYOUT, 8, 64)).toBeNull();
  });

  it("returns null past the last channel", () => {
    const cw = XM_CELL_LAYOUT.cellW;
    const past = ROW_LABEL_W + 8 * cw + 5;
    expect(hitTest(past, 0, 0, 0, XM_CELL_LAYOUT, 8, 64)).toBeNull();
  });

  it("returns null past the last flat row", () => {
    const y = ROW_HEIGHT * 65;
    expect(hitTest(ROW_LABEL_W + 5, y, 0, 0, XM_CELL_LAYOUT, 8, 64)).toBeNull();
  });

  it("decodes (row, channel) at the start of the first cell", () => {
    const hit = hitTest(ROW_LABEL_W + 1, 0, 0, 0, XM_CELL_LAYOUT, 8, 64);
    expect(hit).toEqual({ flatRowIndex: 0, channel: 0, field: "note" });
  });

  it("accounts for scrollTop and scrollLeft", () => {
    const cw = XM_CELL_LAYOUT.cellW;
    const hit = hitTest(
      ROW_LABEL_W + 5, // CSS-pixel x inside the viewport
      ROW_HEIGHT + 1, // y inside viewport
      2 * cw, // 2 channels scrolled off-screen left
      4 * ROW_HEIGHT, // 4 rows scrolled off-screen up
      XM_CELL_LAYOUT,
      8,
      64,
    );
    // y = 1 viewport row + 4 scrolled = row 5; x = ch 2 in viewport + 2 = ch 2
    expect(hit).toEqual({ flatRowIndex: 5, channel: 2, field: "note" });
  });

  it("resolves XM sub-fields: instLo", () => {
    const note = XM_CELL_LAYOUT.fields.find((f) => f.name === "instLo")!;
    const x = ROW_LABEL_W + note.x + 1;
    const hit = hitTest(x, 0, 0, 0, XM_CELL_LAYOUT, 8, 64);
    expect(hit?.field).toBe("instLo");
  });

  it("resolves XM sub-fields: volHi and volLo", () => {
    const volHi = XM_CELL_LAYOUT.fields.find((f) => f.name === "volHi")!;
    const volLo = XM_CELL_LAYOUT.fields.find((f) => f.name === "volLo")!;
    expect(
      hitTest(ROW_LABEL_W + volHi.x + 1, 0, 0, 0, XM_CELL_LAYOUT, 8, 64)?.field,
    ).toBe("volHi");
    expect(
      hitTest(ROW_LABEL_W + volLo.x + 1, 0, 0, 0, XM_CELL_LAYOUT, 8, 64)?.field,
    ).toBe("volLo");
  });

  it("resolves XM sub-fields: effect cmd / hi / lo", () => {
    for (const name of ["effectCmd", "effectHi", "effectLo"] as const) {
      const f = XM_CELL_LAYOUT.fields.find((x) => x.name === name)!;
      const hit = hitTest(
        ROW_LABEL_W + f.x + 1,
        0,
        0,
        0,
        XM_CELL_LAYOUT,
        8,
        64,
      );
      expect(hit?.field).toBe(name);
    }
  });

  it("resolves PT sub-fields and falls back to note on padding", () => {
    const sampleLo = PT_CELL_LAYOUT.fields.find((f) => f.name === "sampleLo")!;
    expect(
      hitTest(ROW_LABEL_W + sampleLo.x + 1, 0, 0, 0, PT_CELL_LAYOUT, 4, 64)
        ?.field,
    ).toBe("sampleLo");
    // Click just inside the cell's right padding — no specific field hit,
    // so the cell falls back to the first field ("note").
    expect(
      hitTest(
        ROW_LABEL_W + PT_CELL_LAYOUT.cellW - 2,
        0,
        0,
        0,
        PT_CELL_LAYOUT,
        4,
        64,
      )?.field,
    ).toBe("note");
  });

  it("clicks landing exactly on the second cell decode to channel 1", () => {
    const cw = XM_CELL_LAYOUT.cellW;
    const hit = hitTest(ROW_LABEL_W + cw + 1, 0, 0, 0, XM_CELL_LAYOUT, 8, 64);
    expect(hit?.channel).toBe(1);
  });
});
