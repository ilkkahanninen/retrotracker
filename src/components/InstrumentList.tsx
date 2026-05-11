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
  /** Drop one or more WAV files onto the slot (1-based) to load samples. */
  onDropFiles?: (index1Based: number, files: File[]) => void;
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
  const [dropTargetSlot, setDropTargetSlot] = createSignal<number | null>(null);

  // Mirrors SampleList's drag detection: dataTransfer.files isn't
  // populated until drop, but `"Files"` is in the types list throughout
  // the drag, so we use that for the visual highlight.
  const dragHasFiles = (e: DragEvent): boolean =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

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
                  "sample--drop-target": dropTargetSlot() === slotNum(),
                }}
                onClick={() => {
                  if (isEditing()) return;
                  props.onSelect(slotNum());
                }}
                onDblClick={() => setEditingSlot(slotNum())}
                onDragOver={(e) => {
                  if (!props.onDropFiles || !dragHasFiles(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTargetSlot(slotNum());
                }}
                onDragLeave={(e) => {
                  e.stopPropagation();
                  if (dropTargetSlot() === slotNum()) setDropTargetSlot(null);
                }}
                onDrop={(e) => {
                  if (!props.onDropFiles || !dragHasFiles(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTargetSlot(null);
                  const files = e.dataTransfer?.files;
                  if (!files || files.length === 0) return;
                  props.onDropFiles(slotNum(), Array.from(files));
                }}
                title={`Select instrument ${slotNum()
                  .toString(16)
                  .toUpperCase()
                  .padStart(
                    2,
                    "0",
                  )} — double-click to rename, drop a .wav to load`}
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
