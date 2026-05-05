import { createSignal } from 'solid-js';
import type { AmigaModel } from '../core/audio/paula';

/**
 * App-wide preferences. Stored in its own localStorage key — separate
 * from the project session (`retrotracker:session:v1`) — because settings
 * outlive any individual `.mod` / `.retro` file: a user's preferred Amiga
 * model, theme, and UI scale should follow the user, not the song.
 *
 * Missing keys in stored payloads fall back to the defaults below, so
 * older saved settings forward-compat without a version bump.
 */

const STORAGE_KEY = 'retrotracker:settings:v1';

export type ColorSchemeId = 'default' | 'light' | 'high-contrast' | 'amber';

/** UI scale slider range, expressed as a percentage of the natural size. */
export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 5;
export const UI_SCALE_DEFAULT = 100;

export interface Settings {
  paulaModel: AmigaModel;
  colorScheme: ColorSchemeId;
  /** UI zoom level as a percentage. 100 = native size. */
  uiScale: number;
}

const DEFAULTS: Settings = {
  paulaModel: 'A1200',
  colorScheme: 'default',
  uiScale: UI_SCALE_DEFAULT,
};

function isColorSchemeId(v: unknown): v is ColorSchemeId {
  return v === 'default' || v === 'light' || v === 'high-contrast' || v === 'amber';
}

function clampUiScale(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULTS.uiScale;
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(n)));
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
    const uiScale = clampUiScale(obj['uiScale']);
    return { paulaModel, colorScheme, uiScale };
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

export function setUiScale(scale: number): void {
  setSettings({ uiScale: clampUiScale(scale) });
}
