import type { Component } from "solid-js";
import type { Song } from "../core/song";
import { INFO_MAX_LINES } from "../state/info";

interface Props {
  /** PT2 or FT2 — both carry a 20-character title in the file header. */
  song: Song;
  filename: string | null;
  infoText: string;
  onTitleChange: (title: string) => void;
  onFilenameChange: (filename: string) => void;
  onInfoTextChange: (text: string) => void;
}

/**
 * Song-level metadata editor, shared by PT2 and FT2 projects. Edits to
 * the title round-trip through the format's commit path (the host picks
 * it) so they participate in undo/redo and stay
 * live during playback; filename and info text are session signals
 * (persisted in `.retro` projects, not in the `.mod` directly — info
 * text is only stamped onto sample names at export time by the caller).
 * All three are editable mid-playback — the worklet keeps its own song
 * snapshot, and the title doesn't affect audio.
 */
export const InfoView: Component<Props> = (props) => {
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
          onInput={(e) => props.onTitleChange(e.currentTarget.value)}
          spellcheck={false}
        />
        <span class="infoview__hint">
          Stored in the {props.song.format === "FT2" ? ".xm" : ".mod"} header
          (20 chars, ASCII).
        </span>
      </label>

      <label class="infoview__field">
        <span class="infoview__label">File name</span>
        <input
          type="text"
          class="infoview__input"
          value={props.filename ?? ""}
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
          onInput={(e) => props.onInfoTextChange(e.currentTarget.value)}
          spellcheck={false}
        />
        <span class="infoview__hint">
          {props.song.format === "FT2"
            ? "Saved with the .retro project; when not empty, replaces the instrument names when exporting .xm (one line each, 22 chars)."
            : "Saved with the .retro project; stamped onto the sample names when exporting .mod."}
        </span>
      </label>
    </section>
  );
};
