import type { Component } from "solid-js";
import type { AmigaModel } from "../core/audio/paula";
import { settings, setPaulaModel } from "../state/settings";

const PAULA_MODELS: { value: AmigaModel; label: string; hint: string }[] = [
  {
    value: "A1200",
    label: "A1200",
    hint: "High-pass only — brighter, no analog low-pass roll-off.",
  },
  {
    value: "A500",
    label: "A500",
    hint: "High-pass + ~4.4 kHz low-pass — darker, classic Amiga tone.",
  },
];

/**
 * Drop focus from radios after the user picks one, so subsequent global
 * shortcuts (Space to play, F2/F3/F4/F5 to switch view, …) flow through
 * the keybind dispatcher instead of being swallowed by the focused
 * radio. Same pattern as SampleView's blur-on-commit for selects and
 * checkboxes — the dispatcher's `focusKind` returns 'text' for any
 * focused INPUT, which silences bare-key shortcuts. Mirrors the
 * approach from commit 57a6133.
 */
const blurOnCommit = (e: Event) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === "radio") {
    t.blur();
  }
};

export const SettingsView: Component = () => {
  return (
    <section class="settingsview" onChange={blurOnCommit}>
      <h2>Settings</h2>

      <fieldset class="settingsview__field">
        <legend class="settingsview__label">Paula filter model (⌘⇧A toggles)</legend>
        <div class="settingsview__radios">
          {PAULA_MODELS.map((m) => (
            <label class="settingsview__radio">
              <input
                type="radio"
                name="paula-model"
                value={m.value}
                checked={settings().paulaModel === m.value}
                onChange={() => setPaulaModel(m.value)}
              />
              <span class="settingsview__radio-label">{m.label}</span>
              <span class="settingsview__hint">{m.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
};
