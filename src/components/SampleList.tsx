import { For, Show, createSignal, type Component } from "solid-js";
import type { Song } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { SAMPLE_NAME_MAX } from "../core/mod/sampleImport";

interface Props {
  song: Song | null;
  onSelect: (index1Based: number) => void;
  onRename: (index1Based: number, name: string) => void;
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

  const submitRename = (slot1Based: number, value: string) => {
    setEditingSlot(null);
    props.onRename(slot1Based, value.slice(0, SAMPLE_NAME_MAX));
  };

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
                  }}
                  onClick={() => {
                    if (isEditing()) return;
                    props.onSelect(slot());
                  }}
                  onDblClick={() => setEditingSlot(slot())}
                  title={`Select sample ${slot().toString(16).toUpperCase().padStart(2, "0")} — double-click to rename`}
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
