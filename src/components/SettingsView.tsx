import { For, type Component } from "solid-js";
import type { AmigaModel } from "../core/audio/paula";
import {
  setColorScheme,
  setPaulaModel,
  setStereoSeparation,
  setUiScale,
  settings,
  STEREO_SEP_DEFAULT,
  STEREO_SEP_MAX,
  STEREO_SEP_MIN,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from "../state/settings";
import { COLOR_SCHEMES } from "../state/theme";

const PAULA_MODELS: { value: AmigaModel; label: string }[] = [
  { value: "A1200", label: "A1200" },
  { value: "A500", label: "A500" },
];

/**
 * Drop focus from radios / selects after the user picks one, so
 * subsequent global shortcuts (Space to play, F2/F3/F4/F5 to switch
 * view, ⌘⇧A to toggle Paula model, …) flow through the keybind
 * dispatcher instead of being swallowed by the still-focused control.
 * Same pattern as SampleView's blur-on-commit (commit 57a6133); range
 * sliders are intentionally NOT blurred — the dispatcher's `focusKind`
 * already lets letters through while a range has focus, and dragging
 * with the keyboard requires the slider to keep focus.
 */
const blurOnCommit = (e: Event) => {
  const t = e.target;
  if (
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLInputElement &&
      (t.type === "radio" || t.type === "checkbox"))
  ) {
    t.blur();
  }
};

export const SettingsView: Component = () => {
  return (
    <section class="settingsview" onChange={blurOnCommit}>
      <h2>Settings</h2>

      <div class="settingsview__group">
        <span class="settingsview__group-label">Audio</span>

        <div class="settingsview__field">
          <span class="settingsview__label">
            Paula filter model (⌘⇧A toggles)
          </span>
          <div class="settingsview__radios">
            <For each={PAULA_MODELS}>
              {(m) => (
                <label class="settingsview__radio">
                  <input
                    type="radio"
                    name="paula-model"
                    value={m.value}
                    checked={settings().paulaModel === m.value}
                    onChange={() => setPaulaModel(m.value)}
                  />
                  <span class="settingsview__radio-label">{m.label}</span>
                </label>
              )}
            </For>
          </div>
        </div>

        <div class="settingsview__field">
          <span class="settingsview__label">
            Stereo separation ({settings().stereoSeparation}%)
            {settings().stereoSeparation !== STEREO_SEP_DEFAULT && (
              <button
                type="button"
                class="settingsview__reset"
                onClick={() => setStereoSeparation(STEREO_SEP_DEFAULT)}
                title={`Reset to ${STEREO_SEP_DEFAULT}%`}
              >
                reset
              </button>
            )}
          </span>
          <input
            class="settingsview__slider"
            type="range"
            min={STEREO_SEP_MIN}
            max={STEREO_SEP_MAX}
            step={1}
            value={settings().stereoSeparation}
            onInput={(e) => setStereoSeparation(Number(e.currentTarget.value))}
          />
        </div>
      </div>

      <div class="settingsview__group">
        <span class="settingsview__group-label">Theme</span>

        <div class="settingsview__field">
          <span class="settingsview__label">Color scheme</span>
          <select
            class="settingsview__select"
            value={settings().colorScheme}
            onChange={(e) => setColorScheme(e.currentTarget.value as never)}
          >
            <For each={COLOR_SCHEMES}>
              {(s) => <option value={s.id}>{s.label}</option>}
            </For>
          </select>
        </div>

        <div class="settingsview__field">
          <span class="settingsview__label">
            UI scale ({settings().uiScale}%)
            {settings().uiScale !== UI_SCALE_DEFAULT && (
              <button
                type="button"
                class="settingsview__reset"
                onClick={() => setUiScale(UI_SCALE_DEFAULT)}
                title="Reset to 100%"
              >
                reset
              </button>
            )}
          </span>
          <input
            class="settingsview__slider"
            type="range"
            min={UI_SCALE_MIN}
            max={UI_SCALE_MAX}
            step={UI_SCALE_STEP}
            value={settings().uiScale}
            onInput={(e) => setUiScale(Number(e.currentTarget.value))}
          />
        </div>
      </div>
    </section>
  );
};
