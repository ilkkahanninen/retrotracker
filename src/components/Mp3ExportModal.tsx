import { Show, type Component } from "solid-js";
import { mp3ExportState } from "../state/mp3Export";

/**
 * Modal shown while `exportMp3()` runs. Two phases:
 *   - "rendering" — replayer is producing PCM, indeterminate bar.
 *   - "encoding"  — LAME is encoding, real progress.
 *
 * Non-dismissable — the export runs to completion, no cancel in v1.
 */
export const Mp3ExportModal: Component = () => {
  return (
    <Show when={mp3ExportState()}>
      {(state) => {
        const phaseLabel = () =>
          state().phase === "rendering" ? "Rendering audio…" : "Encoding MP3…";
        const indeterminate = () => !Number.isFinite(state().frac);
        const pct = () => Math.round(state().frac * 100);
        return (
          <div class="modal-backdrop" role="presentation">
            <div
              class="modal mp3-export"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mp3-export-title"
            >
              <div class="modal__head">
                <h2 id="mp3-export-title">Exporting MP3</h2>
              </div>
              <div class="modal__body mp3-export__body">
                <p class="mp3-export__phase">{phaseLabel()}</p>
                <div
                  class="mp3-export__bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={indeterminate() ? undefined : pct()}
                >
                  <Show
                    when={!indeterminate()}
                    fallback={
                      <div class="mp3-export__fill mp3-export__fill--indeterminate" />
                    }
                  >
                    <div
                      class="mp3-export__fill"
                      style={{ width: `${pct()}%` }}
                    />
                  </Show>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
};
