import { createSignal } from "solid-js";
import type { AmigaModel } from "../core/audio/paula";

/**
 * App-wide preferences. Stored in its own localStorage key — separate
 * from the project session (`retrotracker:session:v1`) — because settings
 * outlive any individual `.mod` / `.retro` file: a user's preferred Amiga
 * model, theme, and UI scale should follow the user, not the song.
 *
 * Missing keys in stored payloads fall back to the defaults below, so
 * older saved settings forward-compat without a version bump.
 */

const STORAGE_KEY = "retrotracker:settings:v1";

export type ColorSchemeId = "default" | "light" | "high-contrast" | "amber";

/** UI scale slider range, expressed as a percentage of the natural size. */
export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 5;
export const UI_SCALE_DEFAULT = 100;

/**
 * Stereo separation slider range (percent). 0 = mono, 100 = full Amiga
 * hard-pan. Default matches pt2-clone (20%).
 */
export const STEREO_SEP_MIN = 0;
export const STEREO_SEP_MAX = 100;
export const STEREO_SEP_DEFAULT = 20;

/**
 * Master playback gain (percent). Multiplier on the engine's output —
 * 100 = unity (1.0×), 200 = +6 dB, etc. The replayer's mix already scales
 * by 0.5 (NORM_FACTOR / PAULA_VOICES) so the worst-case 4-voice peak
 * lands at 1.0; real music sits well below that, leaving headroom we
 * cash in here.
 *
 * Default is 140% (~+3 dB) — audibly louder than the conservative
 * unity setting without clipping typical 4-voice mixes. Live monitoring
 * only: bounce / WAV export and the offline render bypass this gain so
 * exports stay deterministic against pt2-clone reference renders.
 */
export const MASTER_GAIN_MIN = 0;
export const MASTER_GAIN_MAX = 300;
export const MASTER_GAIN_STEP = 5;
export const MASTER_GAIN_DEFAULT = 140;

/** FT2 mixer interpolation modes. `linear` matches our libxmp bed. */
export type Ft2InterpolationMode = "none" | "linear" | "cubic" | "sinc8";

export interface Settings {
  paulaModel: AmigaModel;
  colorScheme: ColorSchemeId;
  /** UI zoom level as a percentage. 100 = native size. */
  uiScale: number;
  /** Stereo separation as a percentage. 0 = mono, 100 = full hard-pan. */
  stereoSeparation: number;
  /** Live-playback master gain as a percentage. 100 = unity. */
  masterGain: number;
  /** Visibility of the pattern-view tips / help right-rail. Toggled from
   *  the Help menu; persisted so the user's choice carries across sessions. */
  showPatternHelp: boolean;
  /** FT2 mixer interpolation. Linear matches libxmp's `-i linear`. */
  ft2Interpolation: Ft2InterpolationMode;
  /** Whether the FT2 mixer applies the anti-click volume ramp. */
  ft2Ramping: boolean;
}

const DEFAULTS: Settings = {
  paulaModel: "A1200",
  colorScheme: "default",
  uiScale: UI_SCALE_DEFAULT,
  stereoSeparation: STEREO_SEP_DEFAULT,
  masterGain: MASTER_GAIN_DEFAULT,
  showPatternHelp: true,
  ft2Interpolation: "linear",
  ft2Ramping: true,
};

function isFt2Interpolation(v: unknown): v is Ft2InterpolationMode {
  return v === "none" || v === "linear" || v === "cubic" || v === "sinc8";
}

function isColorSchemeId(v: unknown): v is ColorSchemeId {
  return (
    v === "default" || v === "light" || v === "high-contrast" || v === "amber"
  );
}

function clampUiScale(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULTS.uiScale;
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(n)));
}

function clampStereoSep(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n))
    return DEFAULTS.stereoSeparation;
  return Math.max(STEREO_SEP_MIN, Math.min(STEREO_SEP_MAX, Math.round(n)));
}

function clampMasterGain(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULTS.masterGain;
  return Math.max(MASTER_GAIN_MIN, Math.min(MASTER_GAIN_MAX, Math.round(n)));
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const obj = parsed as Record<string, unknown>;
    const paulaModel: AmigaModel =
      obj["paulaModel"] === "A500"
        ? "A500"
        : obj["paulaModel"] === "A1200"
          ? "A1200"
          : DEFAULTS.paulaModel;
    const colorScheme: ColorSchemeId = isColorSchemeId(obj["colorScheme"])
      ? obj["colorScheme"]
      : DEFAULTS.colorScheme;
    const uiScale = clampUiScale(obj["uiScale"]);
    const stereoSeparation = clampStereoSep(obj["stereoSeparation"]);
    const masterGain = clampMasterGain(obj["masterGain"]);
    const showPatternHelp =
      typeof obj["showPatternHelp"] === "boolean"
        ? obj["showPatternHelp"]
        : DEFAULTS.showPatternHelp;
    const ft2Interpolation: Ft2InterpolationMode = isFt2Interpolation(
      obj["ft2Interpolation"],
    )
      ? obj["ft2Interpolation"]
      : DEFAULTS.ft2Interpolation;
    const ft2Ramping =
      typeof obj["ft2Ramping"] === "boolean"
        ? obj["ft2Ramping"]
        : DEFAULTS.ft2Ramping;
    return {
      paulaModel,
      colorScheme,
      uiScale,
      stereoSeparation,
      masterGain,
      showPatternHelp,
      ft2Interpolation,
      ft2Ramping,
    };
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
  setPaulaModel(settings().paulaModel === "A1200" ? "A500" : "A1200");
}

export function setColorScheme(scheme: ColorSchemeId): void {
  setSettings({ colorScheme: scheme });
}

export function setUiScale(scale: number): void {
  setSettings({ uiScale: clampUiScale(scale) });
}

export function setStereoSeparation(sep: number): void {
  setSettings({ stereoSeparation: clampStereoSep(sep) });
}

export function setMasterGain(gain: number): void {
  setSettings({ masterGain: clampMasterGain(gain) });
}

export function toggleShowPatternHelp(): void {
  setSettings({ showPatternHelp: !settings().showPatternHelp });
}

export function setFt2Interpolation(mode: Ft2InterpolationMode): void {
  setSettings({ ft2Interpolation: mode });
}

export function setFt2Ramping(on: boolean): void {
  setSettings({ ft2Ramping: on });
}
