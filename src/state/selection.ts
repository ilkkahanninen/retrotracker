import { createSignal } from 'solid-js';

/**
 * A rectangular selection inside a pattern.
 *
 * Tied to an `order`, not a pattern index, because the user navigates by
 * order — when they jump to a different order, we drop the selection so the
 * pattern grid never highlights stale cells. Both axes are *inclusive*
 * (start..end, both ends drawn) and always normalised so start <= end.
 *
 * `null` means "no selection" — copy/cut treat the cursor's single cell as
 * the implicit range in that case (matches FT2 / OpenMPT muscle memory).
 */
export interface PatternSelection {
  order: number;
  startRow: number;
  endRow: number;
  startChannel: number;
  endChannel: number;
}

export const [selection, setSelection] = createSignal<PatternSelection | null>(null);

/**
 * The anchor cell of the current selection — the corner that stays put
 * while shift-arrow / mouse-drag extends the OTHER corner. Stored
 * separately because the normalised PatternSelection doesn't preserve
 * which side is the active end.
 *
 * Lifecycle:
 *   - Set on mousedown (drag anchor) or on the FIRST shift-arrow press
 *     after a clear cursor move (anchor = cursor's pre-move position).
 *   - Cleared by `clearSelection()` (which is what `applyCursor` calls
 *     for plain navigation), so a follow-up shift-arrow re-anchors at
 *     the new cursor.
 */
export const [selectionAnchor, setSelectionAnchor] = createSignal<{
  order: number;
  row: number;
  channel: number;
} | null>(null);

/** Build a normalised selection (`start <= end` on both axes). */
export function makeSelection(
  order: number,
  rowA: number, chA: number,
  rowB: number, chB: number,
): PatternSelection {
  return {
    order,
    startRow:     Math.min(rowA, rowB),
    endRow:       Math.max(rowA, rowB),
    startChannel: Math.min(chA, chB),
    endChannel:   Math.max(chA, chB),
  };
}

/** Drop the current selection AND its anchor. */
export function clearSelection(): void {
  setSelection(null);
  setSelectionAnchor(null);
}

/** Test whether a (row, channel) lies inside the selection. */
export function selectionContains(
  sel: PatternSelection,
  row: number, channel: number,
): boolean {
  return row     >= sel.startRow     && row     <= sel.endRow
      && channel >= sel.startChannel && channel <= sel.endChannel;
}

/** Frame count covered by the selection (rows × channels). */
export function selectionSize(sel: PatternSelection): { rows: number; channels: number } {
  return {
    rows:     sel.endRow     - sel.startRow     + 1,
    channels: sel.endChannel - sel.startChannel + 1,
  };
}
