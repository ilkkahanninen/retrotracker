import { For, Show, createSignal, type Component } from "solid-js";
import type { ModSong } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { SAMPLE_NAME_MAX } from "../core/mod/sampleImport";

interface Props {
  song: ModSong | null;
  onSelect: (index1Based: number) => void;
  onRename: (index1Based: number, name: string) => void;
  /**
   * WAV(s) dropped directly onto a slot — the first goes into `slot1Based`,
   * any extras fan forward across free slots. The list intercepts the
   * drop event so the App-level drop handler doesn't also fire.
   */
  onDropFiles: (slot1Based: number, files: File[]) => void;
}

/**
 * The 31-slot sample list that's shared across the pattern and sample views.
 * Reading current selection from `currentSample()` (rather than props) lets
 * the same instance update reactively without the parent passing it through.
 *
 * Double-clicking a slot's name swaps it for an inline text input —
 * Enter / blur commits, Escape cancels. Saves a trip to the sample editor
 * when the user just wants to rename a slot they spotted while writing
 * patterns.
 */
export const SampleList: Component<Props> = (props) => {
  const [editingSlot, setEditingSlot] = createSignal<number | null>(null);
  const [dropTargetSlot, setDropTargetSlot] = createSignal<number | null>(null);

  const submitRename = (slot1Based: number, value: string) => {
    setEditingSlot(null);
    props.onRename(slot1Based, value.slice(0, SAMPLE_NAME_MAX));
  };

  // True when the drag carries at least one file. dataTransfer.files isn't
  // populated until drop, but the "Files" type is in dataTransfer.types
  // throughout the drag, so we use that to decide whether to highlight.
  const dragHasFiles = (e: DragEvent): boolean =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

  return (
    <Show
      when={props.song}
      fallback={<p class="placeholder">No song loaded</p>}
    >
      {(s) => (
        <ol>
          <For each={s().samples}>
            {(sample, i) => {
              const slot = () => i() + 1;
              const isEditing = () => editingSlot() === slot();
              return (
                <li
                  classList={{
                    "sample--empty": sample.lengthWords === 0,
                    "sample--current": currentSample() === slot(),
                    "sample--drop-target": dropTargetSlot() === slot(),
                  }}
                  onClick={() => {
                    if (isEditing()) return;
                    props.onSelect(slot());
                  }}
                  onDblClick={() => setEditingSlot(slot())}
                  onDragOver={(e) => {
                    if (!dragHasFiles(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTargetSlot(slot());
                  }}
                  onDragLeave={(e) => {
                    e.stopPropagation();
                    if (dropTargetSlot() === slot()) setDropTargetSlot(null);
                  }}
                  onDrop={(e) => {
                    if (!dragHasFiles(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTargetSlot(null);
                    const files = e.dataTransfer?.files;
                    if (!files || files.length === 0) return;
                    props.onDropFiles(slot(), Array.from(files));
                  }}
                  title={`Select sample ${slot().toString(16).toUpperCase().padStart(2, "0")} — double-click to rename, drop a .wav to load`}
                >
                  <span class="num">
                    {slot().toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                  <Show
                    when={isEditing()}
                    fallback={<span class="name">{sample.name || "—"}</span>}
                  >
                    <input
                      class="sample__name-input"
                      type="text"
                      maxLength={SAMPLE_NAME_MAX}
                      value={sample.name}
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
                          submitRename(slot(), e.currentTarget.value);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingSlot(null);
                        }
                      }}
                      onBlur={(e) => {
                        if (editingSlot() === slot())
                          submitRename(slot(), e.currentTarget.value);
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
