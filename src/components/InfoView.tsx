import type { Component } from "solid-js";
import type { Song } from "../core/mod/types";
import { transport } from "../state/song";
import { INFO_LINE_WIDTH, INFO_MAX_LINES } from "../state/info";

interface Props {
  song: Song;
  filename: string | null;
  infoText: string;
  onTitleChange: (title: string) => void;
  onFilenameChange: (filename: string) => void;
  onInfoTextChange: (text: string) => void;
}

/**
 * Song-level metadata editor. Edits to the title round-trip through
 * `commitEdit` so they participate in undo/redo; filename and info text
 * are session signals (persisted in `.retro` projects, not in the `.mod`
 * directly — info text is only stamped onto sample names at export time
 * by the caller). All three controls disable during playback to mirror
 * the rest of the editor's "no edits while playing" rule.
 */
export const InfoView: Component<Props> = (props) => {
  const playing = () => transport() === "playing";

  return (
    <section class="infoview">
      <h2>Info</h2>

      <label class="infoview__field">
        <span class="infoview__label">Song title</span>
        <input
          type="text"
          class="infoview__input"
          maxLength={20}
          value={props.song.title}
          disabled={playing()}
          onInput={(e) => props.onTitleChange(e.currentTarget.value)}
          spellcheck={false}
        />
        <span class="infoview__hint">
          Stored in the .mod header (20 chars, ASCII).
        </span>
      </label>

      <label class="infoview__field">
        <span class="infoview__label">File name</span>
        <input
          type="text"
          class="infoview__input"
          value={props.filename ?? ""}
          disabled={playing()}
          onInput={(e) => props.onFilenameChange(e.currentTarget.value)}
          spellcheck={false}
          placeholder="(derived from title)"
        />
        <span class="infoview__hint">
          Suggested name for downloads. Leave blank to derive from the title.
        </span>
      </label>

      <label class="infoview__field">
        <span class="infoview__label">Info text</span>
        <textarea
          class="infoview__textarea"
          rows={INFO_MAX_LINES}
          value={props.infoText}
          disabled={playing()}
          onInput={(e) => props.onInfoTextChange(e.currentTarget.value)}
          spellcheck={false}
        />
      </label>
    </section>
  );
};
