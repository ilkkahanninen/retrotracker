import { onCleanup, onMount, type Component } from "solid-js";

interface Props {
  onClose: () => void;
}

const USER_MANUAL_URL =
  "https://github.com/ilkkahanninen/retrotracker/blob/main/docs/user-manual.md";
const REPO_URL = "https://github.com/ilkkahanninen/retrotracker";
const PT2_CLONE_URL = "https://github.com/8bitbubsy/pt2-clone";

/**
 * Modal shown by Help → About. Centred overlay, dismissed by clicking the
 * backdrop, the close button, or pressing Escape. Focus is moved to the
 * close button on mount so screen readers announce the dialog and Esc
 * works without first tabbing in.
 */
export const AboutModal: Component<Props> = (props) => {
  let closeBtn: HTMLButtonElement | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => closeBtn?.focus());
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onClick={() => props.onClose()}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__head">
          <h2 id="about-modal-title">About RetroTracker</h2>
          <button
            type="button"
            class="modal__close"
            ref={closeBtn}
            onClick={() => props.onClose()}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div class="modal__body">
          <p>
            <strong>RetroTracker</strong> is a web-based ProTracker module
            editor scoped strictly to 4-channel "M.K." modules. It runs an
            Amiga-Paula emulator (BLEP synthesis, RC + LED filters) that matches{" "}
            <a href={PT2_CLONE_URL} target="_blank" rel="noopener noreferrer">
              pt2-clone
            </a>{" "}
            effect-for-effect, and bundles a non-destructive sample pipeline and
            a built-in chiptune synth.
          </p>
          <p class="modal__links">
            <a href={USER_MANUAL_URL} target="_blank" rel="noopener noreferrer">
              User manual
            </a>{" "}
            ·{" "}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source on GitHub
            </a>
          </p>
          <p>
            By <strong>Naetti tyttoe / jml</strong> (Ilkka Hänninen).
          </p>
          <h3 class="modal__section">Thanks</h3>
          <ul class="modal__thanks">
            <li>
              <strong>Olav "8bitbubsy" Sørensen</strong> — for{" "}
              <a href={PT2_CLONE_URL} target="_blank" rel="noopener noreferrer">
                pt2-clone
              </a>
              , the authoritative ProTracker 2.3D implementation that
              RetroTracker matches effect-for-effect.
            </li>
            <li>
              <strong>aciddose</strong> — for the minimum-phase BLEP table that
              keeps sample transitions from aliasing.
            </li>
            <li>
              <strong>Lars "Zap" Hamre</strong> and the original ProTracker team
              — for the file format and effect set that has anchored
              four-channel tracker music since 1990.
            </li>
            <li>
              The maintainers of <strong>Solid.js</strong> and{" "}
              <strong>Vite</strong>, which power the editor's UI and build
              pipeline.
            </li>
          </ul>
          <p class="modal__credit">Built with Solid.js + Vite + TypeScript.</p>
        </div>
      </div>
    </div>
  );
};
