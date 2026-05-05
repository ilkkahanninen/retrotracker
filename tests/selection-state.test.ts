import { afterEach, describe, expect, it } from "vitest";
import {
  selection,
  setSelection,
  clearSelection,
  makeSelection,
  selectionContains,
  selectionSize,
} from "../src/state/selection";

describe("selection state", () => {
  afterEach(() => clearSelection());

  it("starts as null", () => {
    expect(selection()).toBeNull();
  });

  it("makeSelection normalises swapped row / channel endpoints", () => {
    const sel = makeSelection(0, /*rowA*/ 5, /*chA*/ 3, /*rowB*/ 1, /*chB*/ 0);
    expect(sel).toEqual({
      order: 0,
      startRow: 1,
      endRow: 5,
      startChannel: 0,
      endChannel: 3,
    });
  });

  it("selectionContains reports membership inclusively on both axes", () => {
    const sel = makeSelection(0, 1, 1, 3, 2);
    expect(selectionContains(sel, 1, 1)).toBe(true); // top-left corner
    expect(selectionContains(sel, 3, 2)).toBe(true); // bottom-right corner
    expect(selectionContains(sel, 2, 2)).toBe(true); // interior
    expect(selectionContains(sel, 0, 1)).toBe(false); // row above
    expect(selectionContains(sel, 1, 0)).toBe(false); // channel left
    expect(selectionContains(sel, 4, 1)).toBe(false); // row below
    expect(selectionContains(sel, 1, 3)).toBe(false); // channel right
  });

  it("selectionSize counts inclusive cells on both axes", () => {
    expect(selectionSize(makeSelection(0, 0, 0, 0, 0))).toEqual({
      rows: 1,
      channels: 1,
    });
    expect(selectionSize(makeSelection(0, 1, 0, 4, 2))).toEqual({
      rows: 4,
      channels: 3,
    });
  });

  it("clearSelection drops the active selection", () => {
    setSelection(makeSelection(0, 0, 0, 5, 1));
    expect(selection()).not.toBeNull();
    clearSelection();
    expect(selection()).toBeNull();
  });
});
