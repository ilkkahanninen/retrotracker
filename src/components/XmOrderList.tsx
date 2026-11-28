import { createSignal, For, type Component } from "solid-js";

import type { XmSong } from "../core/xm/types";
import { XM_MAX_ORDERS } from "../core/xm/types";
import { xmCursor } from "../state/cursorXm";
import { Icon } from "./Icon";
import { PatternNameField } from "./PatternNameField";
import {
  canInsertOrders,
  deleteOrderTitle,
  duplicatePatternTitle,
  insertOrderTitle,
  orderSlotTitle,
} from "./orderListShared";
import { isOrderSelected } from "../state/orderSelection";
import { ChevronLeft, ChevronRight, Minus, Plus } from "./icons";
import { patternNames } from "../state/patternNames";
import { playPos, transport } from "../state/song";
import {
  deleteXmOrderSlot,
  duplicateXmCurrentPattern,
  insertXmOrderSlot,
  jumpXmToOrder,
  newXmBlankPatternAtOrder,
  renameXmPattern,
  selectXmOrdersTo,
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
 * cursor to that order; shift-clicking selects a run of entries for
 * Insert / Dup / Delete to act on; double-clicking renames the pattern
 * an entry plays.
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
  // With several slots selected, Insert needs room for a copy of the run.
  const canIns = () => canInsertOrders(props.song.songLength, XM_MAX_ORDERS);
  const canDel = () => props.song.songLength > 1;

  // Order-list slot whose name is being edited — the slot, not the
  // pattern, so a pattern that appears twice opens just one input.
  const [editingOrderIdx, setEditingOrderIdx] = createSignal<number | null>(
    null,
  );

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
          <Icon of={ChevronLeft} />
        </button>
        <button
          type="button"
          onClick={stepXmNextPattern}
          title="Next pattern at slot (⇧])"
          aria-label="Next pattern at slot"
        >
          <Icon of={ChevronRight} />
        </button>
        <button
          type="button"
          onClick={insertXmOrderSlot}
          disabled={!canIns()}
          title={insertOrderTitle(props.song.songLength, XM_MAX_ORDERS)}
          aria-label="Insert slot"
        >
          <Icon of={Plus} />
        </button>
        <button
          type="button"
          onClick={deleteXmOrderSlot}
          disabled={!canDel()}
          title={deleteOrderTitle()}
          aria-label="Delete slot"
        >
          <Icon of={Minus} />
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
          title={duplicatePatternTitle()}
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
                  "orderlist__item--selected": isOrderSelected(i),
                }}
                onClick={(e) => {
                  if (editingOrderIdx() === i) return;
                  // Shift-click selects a run of slots for Insert / Dup /
                  // Delete to act on.
                  if (e.shiftKey) selectXmOrdersTo(i);
                  else jumpXmToOrder(i);
                }}
                onDblClick={(e) => {
                  e.stopPropagation();
                  setEditingOrderIdx(i);
                }}
                title={orderSlotTitle(i)}
              >
                <span class="num">
                  {i.toString(16).toUpperCase().padStart(2, "0")}
                </span>
                <span class="pat">
                  {patternNumber().toString(16).toUpperCase().padStart(2, "0")}
                </span>
                <PatternNameField
                  name={patternNames()[patternNumber()] ?? ""}
                  editing={editingOrderIdx() === i}
                  onCommit={(raw) => {
                    setEditingOrderIdx(null);
                    renameXmPattern(patternNumber(), raw);
                  }}
                  onCancel={() => setEditingOrderIdx(null)}
                />
              </li>
            );
          }}
        </For>
      </ol>
    </>
  );
};
