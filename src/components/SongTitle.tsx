import { createSignal, Show, type Component } from "solid-js";

interface Props {
  title: string;
  /** Called with the raw field text on Enter / blur; the host clamps
   *  it to the format's title width and commits. */
  onCommit: (raw: string) => void;
}

/** Both the PT and XM headers hold a 20-character title. */
const TITLE_MAX = 20;

/**
 * Song title in the pattern meta strip. Double-click swaps the readout
 * for an inline input; Enter or blur commits, Escape cancels. Shared by
 * the PT and FT2 strips.
 */
export const SongTitle: Component<Props> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const commit = (raw: string) => {
    setEditing(false);
    props.onCommit(raw);
  };
  return (
    <Show
      when={editing()}
      fallback={
        <span
          class="patternpane__title"
          title="Double-click to rename song"
          onDblClick={() => setEditing(true)}
        >
          {props.title || <em>(untitled)</em>}
        </span>
      }
    >
      <input
        class="patternpane__title-input"
        type="text"
        maxLength={TITLE_MAX}
        value={props.title}
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.select();
          })
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={(e) => {
          // Enter and Escape unmount the input, which also blurs it.
          if (editing()) commit(e.currentTarget.value);
        }}
      />
    </Show>
  );
};
