import type { XmSong } from "../core/xm/types";
import {
  deleteXmOrder,
  duplicateXmPatternAtOrder,
  insertXmOrderAtCursor,
  newXmPatternAtOrder,
  nextXmPatternAtOrder,
  prevXmPatternAtOrder,
} from "../core/xm/mutations";
import { commitEditXm, playPos, setPlayPos, transport } from "./song";
import { xm2Song as song } from "./song";
import { applyXmCursor } from "./xmPatternEdit";
import { xmCursor } from "./cursorXm";
import { createOrderEdit } from "./orderEditCore";

const ops = createOrderEdit<XmSong>({
  getSong: song,
  songLength: (s) => s.songLength,
  activeOrder: () =>
    transport() === "playing" ? playPos().order : xmCursor().order,
  cursorOrder: () => xmCursor().order,
  applyCursorToOrder: (order) => {
    applyXmCursor({ ...xmCursor(), order, row: 0 });
  },
  commitSong: (transform) => commitEditXm(transform),
  isPlaying: () => transport() === "playing",
  // Why: XM has no engine reroute yet (Phase 5); during playback we just
  // move the visible playhead.
  jumpPlaybackToOrder: (order) => {
    setPlayPos({ order, row: 0 });
  },
  mutations: {
    insertOrder: insertXmOrderAtCursor,
    deleteOrder: deleteXmOrder,
    nextPattern: nextXmPatternAtOrder,
    prevPattern: prevXmPatternAtOrder,
    newPattern: newXmPatternAtOrder,
    duplicatePattern: duplicateXmPatternAtOrder,
  },
});

export const jumpXmToOrder = ops.jumpToOrder;
export const jumpXmPrevOrder = ops.jumpPrev;
export const jumpXmNextOrder = ops.jumpNext;
export const stepXmNextPattern = ops.stepNext;
export const stepXmPrevPattern = ops.stepPrev;
export const insertXmOrderSlot = ops.insertSlot;
export const deleteXmOrderSlot = ops.deleteSlot;
export const newXmBlankPatternAtOrder = ops.newBlankPattern;
export const duplicateXmCurrentPattern = ops.duplicatePattern;
