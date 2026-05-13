export interface OrderEditAdapter<S> {
  getSong: () => S | null;
  songLength: (s: S) => number;
  activeOrder: () => number;
  cursorOrder: () => number;
  applyCursorToOrder: (order: number) => void;
  commitSong: (transform: (s: S) => S) => void;
  isPlaying: () => boolean;
  jumpPlaybackToOrder?: (order: number) => void;
  mutations: {
    insertOrder: (s: S, o: number) => S;
    deleteOrder: (s: S, o: number) => S;
    nextPattern: (s: S, o: number) => S;
    prevPattern: (s: S, o: number) => S;
    newPattern: (s: S, o: number) => S;
    duplicatePattern: (s: S, o: number) => S;
  };
}

export interface OrderEditActions {
  jumpToOrder: (order: number) => void;
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
  function jumpToOrder(order: number): void {
    const s = adapter.getSong();
    if (!s) return;
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
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.insertOrder(s, o));
    const after = adapter.getSong();
    if (!after) return;
    if (adapter.songLength(after) === adapter.songLength(before)) return;
    adapter.applyCursorToOrder(o + 1);
  }

  function deleteSlot(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.deleteOrder(s, o));
    const after = adapter.getSong();
    if (after && adapter.cursorOrder() >= adapter.songLength(after)) {
      adapter.applyCursorToOrder(adapter.songLength(after) - 1);
    }
  }

  function newBlankPattern(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.newPattern(s, o));
  }

  function duplicatePattern(): void {
    const o = adapter.activeOrder();
    adapter.commitSong((s) => adapter.mutations.duplicatePattern(s, o));
  }

  return {
    jumpToOrder,
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
