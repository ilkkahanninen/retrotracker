import {
  clearOrderSelection,
  extendOrderSelection,
  orderSelectionRange,
  setOrderSelection,
} from "./orderSelection";

export interface OrderEditAdapter<S> {
  getSong: () => S | null;
  songLength: (s: S) => number;
  activeOrder: () => number;
  cursorOrder: () => number;
  applyCursorToOrder: (order: number) => void;
  commitSong: (transform: (s: S) => S) => void;
  isPlaying: () => boolean;
  jumpPlaybackToOrder?: (order: number) => void;
  /**
   * Bring cursor / selection back inside the song after a commit that
   * shrank it. Needed because `applyCursorToOrder` refuses to move the
   * cursor while playing with Follow on — and order edits are allowed
   * then, so a delete could otherwise leave the cursor past the end.
   */
  reconcile?: () => void;
  mutations: {
    insertOrder: (s: S, o: number) => S;
    deleteOrder: (s: S, o: number) => S;
    nextPattern: (s: S, o: number) => S;
    prevPattern: (s: S, o: number) => S;
    newPattern: (s: S, o: number) => S;
    duplicatePattern: (s: S, o: number) => S;
    /** Range versions, used when several positions are selected (see
     *  orderSelection.ts). Inclusive `start..end`. */
    repeatRange: (s: S, start: number, end: number) => S;
    duplicatePatternsInRange: (s: S, start: number, end: number) => S;
    deleteRange: (s: S, start: number, end: number) => S;
  };
}

export interface OrderEditActions {
  jumpToOrder: (order: number) => void;
  /** Shift-click: select the run from the anchor to `order`. Doesn't
   *  move the cursor or the playhead. */
  selectTo: (order: number) => void;
  jumpPrev: () => void;
  jumpNext: () => void;
  stepNext: () => void;
  stepPrev: () => void;
  insertSlot: () => void;
  deleteSlot: () => void;
  newBlankPattern: () => void;
  duplicatePattern: () => void;
}

export function createOrderEdit<S>(
  adapter: OrderEditAdapter<S>,
): OrderEditActions {
  /** The selected run, clamped to the song — null when there is none. */
  function selectedRange(): { start: number; end: number } | null {
    const range = orderSelectionRange();
    const s = adapter.getSong();
    if (!range || !s) return null;
    const last = adapter.songLength(s) - 1;
    if (range.start > last) return null;
    return { start: range.start, end: Math.min(range.end, last) };
  }

  function selectTo(order: number): void {
    const s = adapter.getSong();
    if (!s) return;
    const clamped = Math.max(0, Math.min(adapter.songLength(s) - 1, order));
    extendOrderSelection(clamped, adapter.activeOrder());
  }

  function jumpToOrder(order: number): void {
    const s = adapter.getSong();
    if (!s) return;
    // A plain jump (click, [ / ]) ends a multi-selection.
    clearOrderSelection();
    const clamped = Math.max(0, Math.min(adapter.songLength(s) - 1, order));
    if (adapter.isPlaying() && adapter.jumpPlaybackToOrder) {
      adapter.jumpPlaybackToOrder(clamped);
      return;
    }
    adapter.applyCursorToOrder(clamped);
  }

  function jumpPrev(): void {
    const o = adapter.activeOrder();
    if (o <= 0) return;
    jumpToOrder(o - 1);
  }

  function jumpNext(): void {
    const s = adapter.getSong();
    if (!s) return;
    const o = adapter.activeOrder();
    if (o >= adapter.songLength(s) - 1) return;
    jumpToOrder(o + 1);
  }

  function stepNext(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.nextPattern(s, o));
  }

  function stepPrev(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.prevPattern(s, o));
  }

  function insertSlot(): void {
    const before = adapter.getSong();
    if (!before) return;
    // Several positions selected: repeat the run right after itself and
    // move the selection (and the cursor) onto the copy, so a following
    // Dup turns the repeat into its own patterns.
    const range = selectedRange();
    if (range) {
      adapter.commitSong((s) =>
        adapter.mutations.repeatRange(s, range.start, range.end),
      );
      const after = adapter.getSong();
      if (!after) return;
      // Refused — the copy would not fit under the order cap.
      if (adapter.songLength(after) === adapter.songLength(before)) return;
      const count = range.end - range.start + 1;
      setOrderSelection({ anchor: range.end + 1, head: range.end + count });
      adapter.applyCursorToOrder(range.end + 1);
      return;
    }
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.insertOrder(s, o));
    const after = adapter.getSong();
    if (!after) return;
    if (adapter.songLength(after) === adapter.songLength(before)) return;
    adapter.applyCursorToOrder(o + 1);
  }

  function deleteSlot(): void {
    const range = selectedRange();
    if (range) {
      const before = adapter.getSong();
      adapter.commitSong((s) =>
        adapter.mutations.deleteRange(s, range.start, range.end),
      );
      clearOrderSelection();
      const after = adapter.getSong();
      if (before && after) {
        // Keep the cursor on the slot it was on: slots after the run
        // moved left by however many were removed, and a cursor inside
        // the run lands where the run was.
        const removed = adapter.songLength(before) - adapter.songLength(after);
        const cur = adapter.cursorOrder();
        const next =
          cur > range.end ? cur - removed : Math.min(cur, range.start);
        const last = adapter.songLength(after) - 1;
        if (removed > 0 && next !== cur) {
          adapter.applyCursorToOrder(Math.max(0, Math.min(last, next)));
        }
      }
      adapter.reconcile?.();
      return;
    }
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.deleteOrder(s, o));
    const after = adapter.getSong();
    if (after && adapter.cursorOrder() >= adapter.songLength(after)) {
      adapter.applyCursorToOrder(adapter.songLength(after) - 1);
    }
    adapter.reconcile?.();
  }

  function newBlankPattern(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.newPattern(s, o));
  }

  function duplicatePattern(): void {
    // Several positions selected: each gets its own copy of the pattern
    // it plays. The selection stays, on the same positions.
    const range = selectedRange();
    if (range) {
      adapter.commitSong((s) =>
        adapter.mutations.duplicatePatternsInRange(s, range.start, range.end),
      );
      return;
    }
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.duplicatePattern(s, o));
  }

  return {
    jumpToOrder,
    selectTo,
    jumpPrev,
    jumpNext,
    stepNext,
    stepPrev,
    insertSlot,
    deleteSlot,
    newBlankPattern,
    duplicatePattern,
  };
}
