import { Show, type Component } from "solid-js";

import { PATTERN_NAME_MAX } from "../state/patternNames";

interface Props {
  name: string;
  /** Owned by the order list: only one row edits at a time, even when
   *  the same pattern appears in several slots. */
  editing: boolean;
  onCommit: (raw: string) => void;
  onCancel: () => void;
}

/**
 * Pattern-name cell of an order-list row: a readout that the host swaps
 * for an inline input. Enter or blur commits, Escape cancels. Shared by
 * the PT and FT2 order lists.
 */
export const PatternNameField: Component<Props> = (props) => (
  <Show
    when={props.editing}
    fallback={<span class="orderlist__name">{props.name}</span>}
  >
    <input
      class="orderlist__name-input"
      type="text"
      maxLength={PATTERN_NAME_MAX}
      value={props.name}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.select();
        })
      }
      // The row's click handler jumps the cursor to this order.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          props.onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        }
      }}
      onBlur={(e) => {
        // Enter and Escape unmount the input, which also blurs it.
        if (props.editing) props.onCommit(e.currentTarget.value);
      }}
    />
  </Show>
);
