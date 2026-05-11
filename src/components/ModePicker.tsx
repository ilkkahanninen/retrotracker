import { onCleanup, onMount, type Component } from "solid-js";

import type { ProjectFormat } from "../core/song";

interface Props {
  onPick: (format: ProjectFormat) => void;
  onCancel: () => void;
}

/**
 * Shown by File → New. The user picks PT2 (.mod) or FT2 (.xm); the choice
 * is locked for the rest of the project's life. Backdrop / Esc / × button
 * cancel without creating anything.
 */
export const ModePicker: Component<Props> = (props) => {
  let pt2Btn: HTMLButtonElement | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onCancel();
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => pt2Btn?.focus());
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onClick={() => props.onCancel()}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mode-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__head">
          <h2 id="mode-picker-title">New project</h2>
          <button
            type="button"
            class="modal__close"
            onClick={() => props.onCancel()}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div class="modal__body">
          <p>
            Pick a tracker format for this project. The choice is locked for the
            project's life — load the file in a new project to switch.
          </p>
          <div class="mode-picker__choices">
            <button
              type="button"
              class="mode-picker__choice"
              ref={pt2Btn}
              onClick={() => props.onPick("PT2")}
            >
              <span class="mode-picker__name">ProTracker</span>
              <span class="mode-picker__ext">.mod</span>
              <span class="mode-picker__hint">
                4 channels · 31 samples · Paula
              </span>
            </button>
            <button
              type="button"
              class="mode-picker__choice"
              onClick={() => props.onPick("FT2")}
            >
              <span class="mode-picker__name">FastTracker 2</span>
              <span class="mode-picker__ext">.xm</span>
              <span class="mode-picker__hint">
                up to 32 channels · 128 instruments · envelopes
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
