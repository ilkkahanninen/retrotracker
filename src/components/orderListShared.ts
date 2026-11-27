import { orderSelectionRange } from "../state/orderSelection";

/**
 * Wording and enabling for the order-list toolbar (and the Order menu)
 * when several positions are selected. With a multi-selection Insert /
 * Delete / Dup act on the whole run; these keep the two order lists and
 * the menu saying the same thing about it.
 */

/** How many positions the toolbar actions will act on as a run — 0 when
 *  there is no multi-selection and they act on the active position. */
export function selectedOrderCount(): number {
  const range = orderSelectionRange();
  return range ? range.end - range.start + 1 : 0;
}

/** Whether Insert has room: one more slot, or a whole copy of the run. */
export function canInsertOrders(
  songLength: number,
  maxOrders: number,
): boolean {
  return songLength + Math.max(1, selectedOrderCount()) <= maxOrders;
}

export function insertOrderTitle(
  songLength: number,
  maxOrders: number,
): string {
  const n = selectedOrderCount();
  if (n === 0) return "Insert slot at cursor (⌘])";
  return canInsertOrders(songLength, maxOrders)
    ? `Repeat the ${n} selected slots after the selection (⌘])`
    : `No room to repeat ${n} slots — the order list holds ${maxOrders}`;
}

export function deleteOrderTitle(): string {
  const n = selectedOrderCount();
  return n === 0
    ? "Delete slot at cursor (⌘[)"
    : `Delete the ${n} selected slots (⌘[)`;
}

export function duplicatePatternTitle(): string {
  const n = selectedOrderCount();
  return n === 0
    ? "Duplicate pattern at slot (⌥])"
    : `Give the ${n} selected slots their own copies of their patterns (⌥])`;
}

/** Row tooltip for an order-list slot. */
export function orderSlotTitle(order: number): string {
  const hex = order.toString(16).toUpperCase().padStart(2, "0");
  return `Jump to order ${hex} — shift-click to select a run, double-click to rename pattern`;
}
