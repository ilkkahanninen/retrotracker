/**
 * FT2-mode order-list editing — sibling to `state/orderEdit.ts` (PT2).
 * Operates on the XmSong via `commitEditXm` and seeds the FT2 cursor
 * after structural ops so the user lands on the new / surviving slot.
 *
 * Mid-playback semantics: same as PT — the order-list shortcuts target
 * the playhead's order while playing (so `]` reroutes the live mix),
 * the cursor's order otherwise. Phase 5 will plumb the FT2 playhead;
 * until then `playPos().order` is just where the user last left it.
 */

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

function activeOrder(): number {
  return transport() === "playing" ? playPos().order : xmCursor().order;
}

/**
 * Move the cursor to (`order`, row 0). Clamped to `[0, songLength-1]`.
 * Mid-playback this would reroute the engine — Phase 5 plumbs that;
 * for now we only update the cursor.
 */
export function jumpXmToOrder(order: number): void {
  const s = song();
  if (!s) return;
  const clamped = Math.max(0, Math.min(s.songLength - 1, order));
  applyXmCursor({ ...xmCursor(), order: clamped, row: 0 });
  setPlayPos({ order: clamped, row: 0 });
}

export function jumpXmPrevOrder(): void {
  const o = activeOrder();
  if (o <= 0) return;
  jumpXmToOrder(o - 1);
}

export function jumpXmNextOrder(): void {
  const s = song();
  if (!s) return;
  const o = activeOrder();
  if (o >= s.songLength - 1) return;
  jumpXmToOrder(o + 1);
}

export function stepXmNextPattern(): void {
  const o = activeOrder();
  commitEditXm((s) => nextXmPatternAtOrder(s, o));
}

export function stepXmPrevPattern(): void {
  const o = activeOrder();
  commitEditXm((s) => prevXmPatternAtOrder(s, o));
}

export function insertXmOrderSlot(): void {
  const before = song();
  if (!before) return;
  const o = activeOrder();
  commitEditXm((s) => insertXmOrderAtCursor(s, o));
  const after = song();
  if (!after) return;
  // No-op if `insertXmOrderAtCursor` capped at MAX_ORDERS; otherwise the
  // duplicate sits at o+1 and we follow it so `[`/`]` stepping picks up
  // from the fresh slot.
  if (after.songLength === before.songLength) return;
  applyXmCursor({ ...xmCursor(), order: o + 1, row: 0 });
}

export function deleteXmOrderSlot(): void {
  const o = activeOrder();
  commitEditXm((s) => deleteXmOrder(s, o));
  const after = song();
  if (after && xmCursor().order >= after.songLength) {
    applyXmCursor({ ...xmCursor(), order: after.songLength - 1, row: 0 });
  }
}

export function newXmBlankPatternAtOrder(): void {
  const o = activeOrder();
  commitEditXm((s) => newXmPatternAtOrder(s, o));
}

export function duplicateXmCurrentPattern(): void {
  const o = activeOrder();
  commitEditXm((s) => duplicateXmPatternAtOrder(s, o));
}
