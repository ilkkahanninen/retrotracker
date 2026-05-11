import { For, type Component } from "solid-js";

import type { XmSong } from "../core/xm/types";
import { setXmCursor, xmCursor } from "../state/cursorXm";

interface Props {
  song: XmSong;
}

/**
 * Phase 3-3 FT2 order list. Each entry shows order index → pattern number;
 * clicking jumps the FT2 cursor to that order. Highlights the cursor's
 * current order. Mirrors the PT order list's shape so the side panel reads
 * the same in either mode.
 *
 * Editing the order list (insert / delete / rename / new blank /
 * duplicate) lands in Phase 3-4 alongside keyboard editing.
 */
export const XmOrderList: Component<Props> = (props) => {
  const orderIndices = () => {
    const out: number[] = [];
    for (let i = 0; i < props.song.songLength; i++) out.push(i);
    return out;
  };

  return (
    <ol class="orderlist orderlist--xm">
      <For each={orderIndices()}>
        {(i) => {
          const patternNumber = props.song.orders[i] ?? 0;
          return (
            <li
              classList={{
                "orderlist__item--cursor": xmCursor().order === i,
              }}
              onClick={() => {
                setXmCursor({
                  order: i,
                  row: 0,
                  channel: 0,
                  field: "note",
                });
              }}
              title={`Jump to order ${i.toString(16).toUpperCase().padStart(2, "0")}`}
            >
              <span class="num">
                {i.toString(16).toUpperCase().padStart(2, "0")}
              </span>
              <span class="pat">
                {patternNumber.toString(16).toUpperCase().padStart(2, "0")}
              </span>
            </li>
          );
        }}
      </For>
    </ol>
  );
};
