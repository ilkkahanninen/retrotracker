import type { ModSong } from "../core/mod/types";
import {
  cleanupOrders,
  deleteOrder,
  duplicatePatternAtOrder,
  insertOrder,
  newPatternAtOrder,
  nextPatternAtOrder,
  prevPatternAtOrder,
} from "../core/mod/mutations";
import { commitEditWithWorkbenches, playPos, pt2Song, transport } from "./song";
import { cursor, requestJumpToTop } from "./cursor";
import { jumpPlaybackToOrder } from "./playback";
import { applyCursor } from "./patternEdit";
import { createOrderEdit } from "./orderEditCore";

const ops = createOrderEdit<ModSong>({
  getSong: pt2Song,
  songLength: (s) => s.songLength,
  // Why: order-list commands target the playhead while playing (so `]` reroutes
  // the live mix), the cursor when stopped.
  activeOrder: () =>
    transport() === "playing" ? playPos().order : cursor().order,
  cursorOrder: () => cursor().order,
  applyCursorToOrder: (order) => {
    applyCursor({ ...cursor(), order, row: 0 });
    requestJumpToTop();
  },
  commitSong: (transform) =>
    commitEditWithWorkbenches((state) => {
      const next = transform(state.song);
      return next === state.song ? state : { ...state, song: next };
    }),
  isPlaying: () => transport() === "playing",
  jumpPlaybackToOrder: (order) => {
    void jumpPlaybackToOrder(order);
  },
  mutations: {
    insertOrder,
    deleteOrder,
    nextPattern: nextPatternAtOrder,
    prevPattern: prevPatternAtOrder,
    newPattern: newPatternAtOrder,
    duplicatePattern: duplicatePatternAtOrder,
  },
});

export const jumpToOrder = ops.jumpToOrder;
export const jumpPrevOrder = ops.jumpPrev;
export const jumpNextOrder = ops.jumpNext;
export const stepNextPattern = ops.stepNext;
export const stepPrevPattern = ops.stepPrev;
export const insertOrderSlot = ops.insertSlot;
export const deleteOrderSlot = ops.deleteSlot;
export const newBlankPatternAtOrder = ops.newBlankPattern;
export const duplicateCurrentPattern = ops.duplicatePattern;

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
