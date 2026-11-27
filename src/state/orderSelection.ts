import { createSignal } from "solid-js";

/**
 * Multi-selection in the order list: a contiguous run of positions made
 * with shift-click. While it spans more than one position the order
 * toolbar's Insert / Dup / Delete act on the whole run (repeat it, give
 * it its own pattern copies, remove it) instead of the single active
 * position.
 *
 * Format-agnostic — both order lists index positions the same way — and
 * session-only: it is UI state, never saved with the project. Kept
 * separate from the pattern cursor on purpose, so selecting works while
 * the song plays and Follow has the cursor locked.
 */
export interface OrderSelection {
  /** Where the run was started. Stays put while the run is extended. */
  anchor: number;
  /** The most recently shift-clicked position. */
  head: number;
}

const [orderSelection, setOrderSelection] = createSignal<OrderSelection | null>(
  null,
);

export { orderSelection, setOrderSelection };

export function clearOrderSelection(): void {
  if (orderSelection() !== null) setOrderSelection(null);
}

/**
 * The selected run as an inclusive range, or null when nothing is
 * selected — or just one position, which the toolbar treats the same as
 * no selection since every action gives the same result either way.
 */
export function orderSelectionRange(): { start: number; end: number } | null {
  const sel = orderSelection();
  if (!sel || sel.anchor === sel.head) return null;
  return {
    start: Math.min(sel.anchor, sel.head),
    end: Math.max(sel.anchor, sel.head),
  };
}

/** True when `order` lies inside the selected run. */
export function isOrderSelected(order: number): boolean {
  const range = orderSelectionRange();
  return range !== null && order >= range.start && order <= range.end;
}

/**
 * Extend the selection to `to` (shift-click). Keeps the existing anchor;
 * the first extension anchors at `fallbackAnchor` — the active position.
 */
export function extendOrderSelection(to: number, fallbackAnchor: number): void {
  const anchor = orderSelection()?.anchor ?? fallbackAnchor;
  setOrderSelection({ anchor, head: to });
}
