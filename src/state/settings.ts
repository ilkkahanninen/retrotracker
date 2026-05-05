import { createSignal } from 'solid-js';
import type { AmigaModel } from '../core/audio/paula';

/**
 * App-wide preferences. Stored in its own localStorage key — separate
 * from the project session (`retrotracker:session:v1`) — because settings
 * outlive any individual `.mod` / `.retro` file: a user's preferred Amiga
 * model, theme, and contrast level should follow the user, not the song.
 *
 * Missing keys in stored payloads fall back to the defaults below, so
 * older saved settings forward-compat without a version bump.
 */

const STORAGE_KEY = 'retrotracker:settings:v1';

export type ColorSchemeId = 'default' | 'light' | 'high-contrast' | 'amber';

export interface Settings {
  paulaModel: AmigaModel;
  colorScheme: ColorSchemeId;
}

const DEFAULTS: Settings = {
  paulaModel: 'A1200',
  colorScheme: 'default',
};

function isColorSchemeId(v: unknown): v is ColorSchemeId {
  return v === 'default' || v === 'light' || v === 'high-contrast' || v === 'amber';
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    const obj = parsed as Record<string, unknown>;
    const paulaModel: AmigaModel =
      obj['paulaModel'] === 'A500' ? 'A500'
      : obj['paulaModel'] === 'A1200' ? 'A1200'
      : DEFAULTS.paulaModel;
    const colorScheme: ColorSchemeId = isColorSchemeId(obj['colorScheme'])
      ? obj['colorScheme']
      : DEFAULTS.colorScheme;
    return { paulaModel, colorScheme };
  } catch {
    return { ...DEFAULTS };
  }
}

const [settings, setSettingsSignal] = createSignal<Settings>(load());

export { settings };

/**
 * Patch one or more settings and write the new value through to
 * localStorage. Persisted via a write-through wrapper rather than a
 * top-level `createEffect` so the persistence side-effect doesn't
 * require a Solid reactive root at module scope.
 */
export function setSettings(patch: Partial<Settings>): void {
  const next = { ...settings(), ...patch };
  setSettingsSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private-mode — silent, matches session persistence.
  }
}

export function setPaulaModel(model: AmigaModel): void {
  setSettings({ paulaModel: model });
}

/** Flip between A1200 and A500. Bound to ⌘⇧A in `appKeybinds`. */
export function togglePaulaModel(): void {
  setPaulaModel(settings().paulaModel === 'A1200' ? 'A500' : 'A1200');
}

export function setColorScheme(scheme: ColorSchemeId): void {
  setSettings({ colorScheme: scheme });
}
