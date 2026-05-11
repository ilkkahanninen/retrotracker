import { For, Show, createSignal, type Component } from "solid-js";

/**
 * Generic slot list used by both PT2 (sample list) and FT2 (instrument
 * list). Each format provides:
 *
 * - `slots()` — the slot display data (name + empty flag), or null when
 *   no song is loaded. PT iterates `song.samples` directly (31 entries);
 *   FT2 builds a sparse 128-entry view from `song.instruments`.
 * - `currentSlot()` — the 1-based selected slot.
 * - callbacks for select / rename / optional drop-WAV.
 * - `nameMaxLength` — 22 for both today, but kept per-format for clarity.
 * - `itemLabel` — "sample" / "instrument" for the hover tooltip.
 *
 * Inline rename, drag-drop highlighting, and the "no song loaded"
 * placeholder are shared.
 */
export interface SlotDisplay {
  name: string;
  isEmpty: boolean;
}

interface Props {
  slots: () => SlotDisplay[] | null;
  currentSlot: () => number;
  onSelect: (slot1Based: number) => void;
  onRename: (slot1Based: number, name: string) => void;
  /**
   * Optional: WAV(s) dropped directly onto a slot — the first goes into
   * the slot, any extras fan forward across free slots. The list
   * intercepts the drop event so the App-level drop handler doesn't also
   * fire.
   */
  onDropFiles?: (slot1Based: number, files: File[]) => void;
  nameMaxLength: number;
  itemLabel: string;
}

// True when the drag carries at least one file. dataTransfer.files isn't
// populated until drop, but the "Files" type is in dataTransfer.types
// throughout the drag, so we use that to decide whether to highlight.
const dragHasFiles = (e: DragEvent): boolean =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

export const SlotList: Component<Props> = (props) => {
  const [editingSlot, setEditingSlot] = createSignal<number | null>(null);
  const [dropTargetSlot, setDropTargetSlot] = createSignal<number | null>(null);

  const submitRename = (slot1Based: number, value: string) => {
    setEditingSlot(null);
    props.onRename(slot1Based, value.slice(0, props.nameMaxLength));
  };

  return (
    <Show
      when={props.slots()}
      fallback={<p class="placeholder">No song loaded</p>}
    >
      {(slots) => (
        <ol>
          <For each={slots()}>
            {(slot, i) => {
              const slotNum = () => i() + 1;
              const isEditing = () => editingSlot() === slotNum();
              const slotHex = () =>
                slotNum().toString(16).toUpperCase().padStart(2, "0");
              return (
                <li
                  classList={{
                    "sample--empty": slot.isEmpty,
                    "sample--current": props.currentSlot() === slotNum(),
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
                  title={`Select ${props.itemLabel} ${slotHex()} — double-click to rename, drop a .wav to load`}
                >
                  <span class="num">{slotHex()}</span>
                  <Show
                    when={isEditing()}
                    fallback={<span class="name">{slot.name || "—"}</span>}
                  >
                    <input
                      class="sample__name-input"
                      type="text"
                      maxLength={props.nameMaxLength}
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
      )}
    </Show>
  );
};
