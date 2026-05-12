import { For, type Component } from "solid-js";

import type { XmSong } from "../core/xm/types";
import { XM_MAX_ORDERS } from "../core/xm/types";
import { xmCursor } from "../state/cursorXm";
import { playPos, transport } from "../state/song";
import {
  deleteXmOrderSlot,
  duplicateXmCurrentPattern,
  insertXmOrderSlot,
  jumpXmToOrder,
  newXmBlankPatternAtOrder,
  stepXmNextPattern,
  stepXmPrevPattern,
} from "../state/xmOrderEdit";

interface Props {
  song: XmSong;
}

/**
 * FT2 order list. Mirrors PT2's order list layout: a six-button toolbar
 * (Prev / Next pattern, Insert / Delete slot, New blank, Duplicate)
 * above an ordered list of entries. Clicking an entry jumps the FT2
 * cursor to that order.
 *
 * Pattern-number readouts are wrapped in thunks so a `commitEditXm`
 * that swaps the order at a slot re-paints just that slot — `For`'s
 * keyed-by-index children only re-render their tracked accessors, not
 * the whole list.
 */
export const XmOrderList: Component<Props> = (props) => {
  const playing = () => transport() === "playing";
  const activeIdx = () => (playing() ? playPos().order : xmCursor().order);
  const slotPat = () => props.song.orders[activeIdx()] ?? 0;
  const canPrev = () => slotPat() > 0;
  const canIns = () => props.song.songLength < XM_MAX_ORDERS;
  const canDel = () => props.song.songLength > 1;

  const orderIndices = () => {
    const out: number[] = [];
    for (let i = 0; i < props.song.songLength; i++) out.push(i);
    return out;
  };

  return (
    <>
      <div class="ordertools">
        <button
          type="button"
          onClick={stepXmPrevPattern}
          disabled={!canPrev()}
          title="Previous pattern at slot (⇧[)"
          aria-label="Previous pattern at slot"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={stepXmNextPattern}
          title="Next pattern at slot (⇧])"
          aria-label="Next pattern at slot"
        >
          ›
        </button>
        <button
          type="button"
          onClick={insertXmOrderSlot}
          disabled={!canIns()}
          title="Insert slot at cursor (⌘])"
          aria-label="Insert slot"
        >
          +
        </button>
        <button
          type="button"
          onClick={deleteXmOrderSlot}
          disabled={!canDel()}
          title="Delete slot at cursor (⌘[)"
          aria-label="Delete slot"
        >
          −
        </button>
        <button
          type="button"
          onClick={newXmBlankPatternAtOrder}
          title="New blank pattern at slot (⌥[)"
          aria-label="New blank pattern"
        >
          New
        </button>
        <button
          type="button"
          onClick={duplicateXmCurrentPattern}
          title="Duplicate pattern at slot (⌥])"
          aria-label="Duplicate pattern"
        >
          Dup
        </button>
      </div>
      <ol class="orderlist orderlist--xm">
        <For each={orderIndices()}>
          {(i) => {
            // Pattern number lives behind a thunk so a commit that
            // re-points the slot at a different pattern triggers a
            // localised re-paint — without this, the For child closes
            // over the initial value and stays stale.
            const patternNumber = () => props.song.orders[i] ?? 0;
            return (
              <li
                classList={{
                  "orderlist__item--active": i === playPos().order,
                  "orderlist__item--cursor":
                    !playing() && i === xmCursor().order,
                }}
                onClick={() => jumpXmToOrder(i)}
                title={`Jump to order ${i.toString(16).toUpperCase().padStart(2, "0")}`}
              >
                <span class="num">
                  {i.toString(16).toUpperCase().padStart(2, "0")}
                </span>
                <span class="pat">
                  {patternNumber().toString(16).toUpperCase().padStart(2, "0")}
                </span>
              </li>
            );
          }}
        </For>
      </ol>
    </>
  );
};
