import { For, Show, createSignal, type Component } from "solid-js";

import {
  XM_INSTRUMENT_NAME_MAX,
  XM_MAX_INSTRUMENTS,
  type XmSong,
} from "../core/xm/types";
import { currentXmInstrument } from "../state/xmEdit";

interface Props {
  song: XmSong | null;
  onSelect: (index1Based: number) => void;
  onRename: (index1Based: number, name: string) => void;
}

/**
 * FT2 instrument list — sibling to the PT `SampleList`. Shows all 128
 * slots so the user can navigate the full XM instrument range; slots
 * past the song's `instruments` array length render as empty (XM allows
 * sparse instrument tables — the writer fills the gap with stand-ins on
 * save). Reuses the PT list's `.sample--*` styles for look-and-feel
 * parity.
 *
 * Phase 4 will wire WAV drop-import here; for now the list is select +
 * rename only.
 */
export const InstrumentList: Component<Props> = (props) => {
  const [editingSlot, setEditingSlot] = createSignal<number | null>(null);

  const submitRename = (slot1Based: number, value: string) => {
    setEditingSlot(null);
    props.onRename(slot1Based, value.slice(0, XM_INSTRUMENT_NAME_MAX));
  };

  /** Slot list 1..128. Each slot reads the matching index of the (possibly
   *  shorter) `instruments` array, defaulting to an empty placeholder name. */
  const slots = () => {
    const arr: { name: string; isEmpty: boolean }[] = new Array(
      XM_MAX_INSTRUMENTS,
    );
    const insts = props.song?.instruments ?? [];
    for (let i = 0; i < XM_MAX_INSTRUMENTS; i++) {
      const inst = insts[i];
      arr[i] = {
        name: inst?.name ?? "",
        // "Empty" = no samples loaded yet. A named instrument with zero
        // samples still styles as empty so the user notices it can't
        // produce sound — same logic as PT2's `lengthWords === 0`.
        isEmpty: !inst || inst.samples.length === 0,
      };
    }
    return arr;
  };

  return (
    <Show
      when={props.song}
      fallback={<p class="placeholder">No song loaded</p>}
    >
      <ol>
        <For each={slots()}>
          {(slot, i) => {
            const slotNum = () => i() + 1;
            const isEditing = () => editingSlot() === slotNum();
            return (
              <li
                classList={{
                  "sample--empty": slot.isEmpty,
                  "sample--current": currentXmInstrument() === slotNum(),
                }}
                onClick={() => {
                  if (isEditing()) return;
                  props.onSelect(slotNum());
                }}
                onDblClick={() => setEditingSlot(slotNum())}
                title={`Select instrument ${slotNum()
                  .toString(16)
                  .toUpperCase()
                  .padStart(2, "0")} — double-click to rename`}
              >
                <span class="num">
                  {slotNum().toString(16).toUpperCase().padStart(2, "0")}
                </span>
                <Show
                  when={isEditing()}
                  fallback={<span class="name">{slot.name || "—"}</span>}
                >
                  <input
                    class="sample__name-input"
                    type="text"
                    maxLength={XM_INSTRUMENT_NAME_MAX}
                    value={slot.name}
                    ref={(el) =>
                      queueMicrotask(() => {
                        el.focus();
                        el.select();
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitRename(slotNum(), e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingSlot(null);
                      }
                    }}
                    onBlur={(e) => {
                      if (editingSlot() === slotNum())
                        submitRename(slotNum(), e.currentTarget.value);
                    }}
                  />
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </Show>
  );
};
