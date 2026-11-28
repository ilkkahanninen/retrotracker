import type { XmSong } from "../core/xm/types";
import {
  cleanupXmOrders,
  deleteXmOrder,
  deleteXmOrderRange,
  duplicateXmPatternAtOrder,
  duplicateXmPatternsInRange,
  insertXmOrderAtCursor,
  newXmPatternAtOrder,
  nextXmPatternAtOrder,
  prevXmPatternAtOrder,
  repeatXmOrderRange,
} from "../core/xm/mutations";
import {
  commitEditXmLive,
  commitEditXmWithPatternNames,
  playPos,
  transport,
} from "./song";
import { jumpPlaybackToOrder } from "./playback";
import { reconcileUiToSong } from "./reconcile";
import { xm2Song as song } from "./song";
import { applyXmCursor } from "./xmPatternEdit";
import { requestJumpToTop } from "./cursor";
import { xmCursor } from "./cursorXm";
import { createOrderEdit } from "./orderEditCore";
import { remapPatternNames, withPatternName } from "./patternNames";

const ops = createOrderEdit<XmSong>({
  getSong: song,
  songLength: (s) => s.songLength,
  activeOrder: () =>
    transport() === "playing" ? playPos().order : xmCursor().order,
  cursorOrder: () => xmCursor().order,
  applyCursorToOrder: (order) => {
    applyXmCursor({ ...xmCursor(), order, row: 0 });
    // Pin the destination to the top of the grid, as the PT list does.
    requestJumpToTop();
  },
  // Ungated, like PT: order edits stay live during playback whatever
  // Follow says, and sync.ts pushes the new song to the worklet.
  commitSong: commitEditXmLive,
  isPlaying: () => transport() === "playing",
  jumpPlaybackToOrder: (order) => {
    void jumpPlaybackToOrder(order);
  },
  reconcile: reconcileUiToSong,
  mutations: {
    insertOrder: insertXmOrderAtCursor,
    deleteOrder: deleteXmOrder,
    nextPattern: nextXmPatternAtOrder,
    prevPattern: prevXmPatternAtOrder,
    newPattern: newXmPatternAtOrder,
    duplicatePattern: duplicateXmPatternAtOrder,
    repeatRange: repeatXmOrderRange,
    duplicatePatternsInRange: duplicateXmPatternsInRange,
    deleteRange: deleteXmOrderRange,
  },
});

export const jumpXmToOrder = ops.jumpToOrder;
export const selectXmOrdersTo = ops.selectTo;
export const jumpXmPrevOrder = ops.jumpPrev;
export const jumpXmNextOrder = ops.jumpNext;
export const stepXmNextPattern = ops.stepNext;
export const stepXmPrevPattern = ops.stepPrev;
export const insertXmOrderSlot = ops.insertSlot;
export const deleteXmOrderSlot = ops.deleteSlot;
export const newXmBlankPatternAtOrder = ops.newBlankPattern;
export const duplicateXmCurrentPattern = ops.duplicatePattern;

/**
 * Order → Clean up for FT2 songs. Refused during any playback, like the PT
 * one: the worklet's song snapshot still uses the old pattern numbers.
 * Pattern names are re-keyed in the same commit so undo restores both.
 */
export function cleanupXmOrderList(): void {
  if (transport() === "playing") return;
  commitEditXmWithPatternNames((state) => {
    const result = cleanupXmOrders(state.song);
    if (result.song === state.song) return state;
    return {
      ...state,
      song: result.song,
      patternNames: remapPatternNames(state.patternNames, result.remap),
    };
  });
}

/**
 * Rename a pattern (project-only metadata) as an undoable edit — the FT2
 * counterpart of `renamePattern`. Ungated: names don't affect audio, so
 * renaming stays available while playing.
 */
export function renameXmPattern(patternIndex: number, name: string): void {
  commitEditXmWithPatternNames((state) => {
    const patternNames = withPatternName(
      state.patternNames,
      patternIndex,
      name,
    );
    return patternNames === state.patternNames
      ? state
      : { ...state, patternNames };
  });
}
