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

/**
 * Order-list editing. Allowed mid-playback (next play / restart picks
 * up the change). Routed through `commitEditWithWorkbenches` so the
 * commit doesn't gate on transport and carries workbenches +
 * patternNames through unchanged.
 */

/**
 * Order-list commands target the playhead's order while playing, the
 * cursor's order when stopped — otherwise pressing `]` mid-playback
 * would bump whichever slot the user last navigated to before play.
 */
function activeOrder(): number {
  return transport() === "playing" ? playPos().order : cursor().order;
}

/**
 * Mid-playback this re-routes the engine instead of the cursor — the
 * replayer restarts at (order, 0) keeping the current playMode, so
 * clicking an order-list slot reroutes the song without stopping.
 */
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
  // No-op when `insertOrder` was capped at MAX_ORDERS. Otherwise the
  // duplicate sits at o+1, where the cursor follows so the user can
  // step it to a different pattern via `<` / `>` immediately.
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

/**
 * Renumber patterns by first appearance and drop unused ones. The song
 * change and pattern-name re-keying share one commit; without the
 * bundle, undo would leave names mapped to the cleaned-up indices while
 * the song reverts to the pre-cleanup pattern numbering.
 */
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
