import { createSignal } from 'solid-js';
import type { AmigaModel } from '../core/audio/paula';

/**
 * App-wide preferences. Stored in its own localStorage key — separate
 * from the project session (`retrotracker:session:v1`) — because settings
 * outlive any individual `.mod` / `.retro` file: a user's preferred Amiga
 * model should follow the user, not the song.
 *
 * Schema is intentionally tiny right now (one field). Add new keys with
 * sensible defaults; missing keys in stored payloads fall back to the
 * defaults below, so older saved settings forward-compat without a
 * version bump.
 */

const STORAGE_KEY = 'retrotracker:settings:v1';

export interface Settings {
  paulaModel: AmigaModel;
}

const DEFAULTS: Settings = {
  paulaModel: 'A1200',
};

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
    return { paulaModel };
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

/** Flip between A1200 and A500. Bound to F11 in `appKeybinds`. */
export function togglePaulaModel(): void {
  setPaulaModel(settings().paulaModel === 'A1200' ? 'A500' : 'A1200');
}
