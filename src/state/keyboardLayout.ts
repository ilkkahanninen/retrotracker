import { createSignal } from "solid-js";
import { KEY_CODE_MAP } from "./shortcuts";

/**
 * Translate position-based shortcut keys to the user's actual keycap
 * labels via the `Keyboard.getLayoutMap()` web API.
 *
 * Browser support: Chromium-based browsers (Chrome, Edge, Brave, Opera,
 * Arc) implement `navigator.keyboard.getLayoutMap()`. Safari and Firefox
 * do not; on those we fall back to the original QWERTY string the
 * shortcut was registered with — same as before this layer existed, so
 * users on unsupported browsers don't regress.
 *
 * The map is fetched lazily on first use (the API is async) and stored
 * in a Solid signal so any component that called `keyLabel` re-renders
 * once the labels arrive. Re-fetching on `layoutchange` keeps the labels
 * in sync if the user switches input source mid-session.
 */

type LayoutMap = Map<string, string>;

const [layoutMap, setLayoutMap] = createSignal<LayoutMap | null>(null);

let initStarted = false;

interface KeyboardApi {
  getLayoutMap(): Promise<LayoutMap>;
  addEventListener?: (type: string, listener: () => void) => void;
}

function getKeyboardApi(): KeyboardApi | null {
  if (typeof navigator === "undefined") return null;
  // `navigator.keyboard` is a non-standard, Chromium-only field. We do
  // unknown-cast to keep TS quiet — the runtime guard below is what
  // actually decides whether the API is usable.
  const kb = (navigator as unknown as { keyboard?: KeyboardApi }).keyboard;
  if (!kb || typeof kb.getLayoutMap !== "function") return null;
  return kb;
}

/**
 * Kick off layout-map fetch (idempotent). Components don't need to call
 * this — `keyLabel` triggers it on first invocation. Exposed for tests
 * and for the rare caller that wants to warm the cache eagerly.
 */
export function initKeyboardLayout(): void {
  if (initStarted) return;
  initStarted = true;
  const kb = getKeyboardApi();
  if (!kb) return;
  const refresh = () => {
    kb.getLayoutMap()
      .then(setLayoutMap)
      .catch(() => {
        // The promise can reject in restricted contexts (sandboxed iframes,
        // permission-policy blocks). Falling back to QWERTY labels is fine.
      });
  };
  refresh();
  // Re-read whenever the OS reports a layout change so a user toggling
  // between input sources sees the help text update without a reload.
  kb.addEventListener?.("layoutchange", refresh);
}

/**
 * Map a single shortcut key (`'a'`, `';'`, `'z'`, …) to the user's
 * keycap label. Letters come back uppercase to match how they appear
 * on physical keycaps; non-letters are returned as-is from the layout
 * map (which already returns punctuation un-shifted).
 *
 * Returns the input unchanged when the layout API is unavailable or
 * hasn't loaded yet — callers don't need to handle a "loading" state,
 * the signal re-renders them once the data arrives.
 */
export function keyLabel(key: string): string {
  initKeyboardLayout();
  const map = layoutMap();
  if (!map) return key.length === 1 ? key.toUpperCase() : key;
  const code = KEY_CODE_MAP[key.toLowerCase()];
  if (!code) return key;
  const label = map.get(code);
  if (!label) return key.length === 1 ? key.toUpperCase() : key;
  return key.length === 1 ? label.toUpperCase() : label;
}

/**
 * Remap each character of a position-based help string to the user's
 * keycap label. Spaces, slashes, dashes, and other separators are
 * passed through unchanged so a string like `"A W S E D"` or `"Z / X"`
 * stays readable on any layout.
 */
export function remapPositionKeys(text: string): string {
  // We have to consult the signal explicitly here so Solid tracks the
  // dependency in the calling reactive context — `keyLabel` reads the
  // signal too, but only via the per-character path which Solid sees as
  // many independent reads. Reading once up front is cheaper.
  initKeyboardLayout();
  const map = layoutMap();
  if (!map) return text;
  return text
    .split("")
    .map((ch) => {
      const code = KEY_CODE_MAP[ch.toLowerCase()];
      if (!code) return ch;
      const label = map.get(code);
      if (!label) return ch;
      return ch === ch.toLowerCase() ? label : label.toUpperCase();
    })
    .join("");
}

/** Test hook: replace the layout map directly without touching navigator. */
export function __setLayoutMapForTests(m: LayoutMap | null): void {
  setLayoutMap(m);
  initStarted = m !== null;
}
