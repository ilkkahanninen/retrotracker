import {
  cleanupOrders,
  deleteOrder,
  duplicatePatternAtOrder,
  insertOrder,
  newPatternAtOrder,
  nextPatternAtOrder,
  prevPatternAtOrder,
} from "../core/mod/mutations";
import { commitEditWithWorkbenches, playPos, song, transport } from "./song";
import { cursor, requestJumpToTop } from "./cursor";
import { jumpPlaybackToOrder } from "./playback";
import { applyCursor } from "./patternEdit";

// Why: order-list commands target the playhead while playing (so `]` reroutes
// the live mix), the cursor when stopped.
function activeOrder(): number {
  return transport() === "playing" ? playPos().order : cursor().order;
}

export function jumpToOrder(order: number): void {
  const s = song();
  if (!s) return;
  const clamped = Math.max(0, Math.min(s.songLength - 1, order));
  if (transport() === "playing") {
    void jumpPlaybackToOrder(clamped);
    return;
  }
  applyCursor({ ...cursor(), order: clamped, row: 0 });
  requestJumpToTop();
}

export function jumpPrevOrder(): void {
  const o = activeOrder();
  if (o <= 0) return;
  jumpToOrder(o - 1);
}

export function jumpNextOrder(): void {
  const s = song();
  if (!s) return;
  const o = activeOrder();
  if (o >= s.songLength - 1) return;
  jumpToOrder(o + 1);
}

export function stepNextPattern(): void {
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = nextPatternAtOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
}

export function stepPrevPattern(): void {
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = prevPatternAtOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
}

export function insertOrderSlot(): void {
  const before = song();
  if (!before) return;
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = insertOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
  const after = song();
  if (!after) return;
  if (after.songLength === before.songLength) return;
  applyCursor({ ...cursor(), order: o + 1, row: 0 });
  requestJumpToTop();
}

export function deleteOrderSlot(): void {
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = deleteOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
  const after = song();
  if (after && cursor().order >= after.songLength) {
    applyCursor({ ...cursor(), order: after.songLength - 1, row: 0 });
  }
}

export function newBlankPatternAtOrder(): void {
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = newPatternAtOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
}

export function duplicateCurrentPattern(): void {
  const o = activeOrder();
  commitEditWithWorkbenches((state) => {
    const next = duplicatePatternAtOrder(state.song, o);
    return next === state.song ? state : { ...state, song: next };
  });
}

// Why: song change and pattern-name re-keying must share one commit;
// without the bundle, undo leaves names mapped to cleaned-up indices while
// the song reverts to pre-cleanup numbering.
export function cleanupOrderList(): void {
  if (transport() === "playing") return;
  commitEditWithWorkbenches((state) => {
    const result = cleanupOrders(state.song);
    if (result.song === state.song) return state;
    const oldNames = state.patternNames;
    const newNames: Record<number, string> = {};
    for (const key of Object.keys(oldNames)) {
      const oldIdx = Number(key);
      const newIdx = result.remap[oldIdx];
      if (newIdx !== undefined) newNames[newIdx] = oldNames[oldIdx]!;
    }
    return { ...state, song: result.song, patternNames: newNames };
  });
}
