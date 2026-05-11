import { createSignal } from "solid-js";

/**
 * FT2-mode pattern selection — sibling to `state/selection.ts`. Tied to
 * `order` (not pattern index): a cross-order navigation drops the
 * rectangle so the grid never highlights stale cells.
 *
 * Cross-format paste is rejected by tagging the clipboard slice with
 * the format that produced it — see `state/clipboardXm.ts`.
 */
export interface XmPatternSelection {
  order: number;
  startRow: number;
  endRow: number;
  startChannel: number;
  endChannel: number;
}

export const [xmSelection, setXmSelection] =
  createSignal<XmPatternSelection | null>(null);

export const [xmSelectionAnchor, setXmSelectionAnchor] = createSignal<{
  order: number;
  row: number;
  channel: number;
} | null>(null);

/** Build a normalised selection (`start <= end` on both axes). */
export function makeXmSelection(
  order: number,
  rowA: number,
  chA: number,
  rowB: number,
  chB: number,
): XmPatternSelection {
  return {
    order,
    startRow: Math.min(rowA, rowB),
    endRow: Math.max(rowA, rowB),
    startChannel: Math.min(chA, chB),
    endChannel: Math.max(chA, chB),
  };
}

export function clearXmSelection(): void {
  setXmSelection(null);
  setXmSelectionAnchor(null);
}

export function xmSelectionContains(
  sel: XmPatternSelection,
  row: number,
  channel: number,
): boolean {
  return (
    row >= sel.startRow &&
    row <= sel.endRow &&
    channel >= sel.startChannel &&
    channel <= sel.endChannel
  );
}
