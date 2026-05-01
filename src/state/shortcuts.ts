import { redo, undo } from './song';

/**
 * Keyboard shortcut registry.
 *
 * The module ships with the always-available shortcuts (Undo / Redo) baked
 * in. App-level bindings whose handlers depend on component state call
 * `registerShortcut` at mount time and dispose with the returned cleanup.
 *
 * Conventions:
 *   - `mod: true` means ⌘ on macOS, Ctrl on Windows/Linux.
 *   - `key` is matched case-insensitively against `KeyboardEvent.key`.
 *     Use `' '` for the spacebar and lowercase names for the rest
 *     (e.g. 'enter', 'arrowup').
 *   - `description` is human-readable and will drive a cheat-sheet UI later.
 */
export interface Shortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  run: () => void;
  /**
   * Optional keyup handler. When present, the shortcut acts as a "press and
   * hold" binding: auto-repeat keydowns are suppressed (so `run` fires once
   * per real press), and `runUp` fires when the user releases the key. Used
   * for note-preview audition where the sound should stop on release.
   */
  runUp?: () => void;
  /**
   * Optional gate: when present and returning false, this shortcut does not
   * match — the dispatcher continues looking for the next match. Lets two
   * shortcuts share the same key+modifiers but route by app state (e.g. piano
   * keys when the cursor is on a note field; hex digits otherwise).
   */
  when?: () => boolean;
}

const registered: Shortcut[] = [
  { key: 'z', mod: true,             description: 'Undo', run: undo },
  { key: 'z', mod: true, shift: true, description: 'Redo', run: redo },
  { key: 'y', mod: true,             description: 'Redo', run: redo },
];

/** Add a shortcut at runtime. Returns a function that removes it. */
export function registerShortcut(s: Shortcut): () => void {
  registered.push(s);
  return () => {
    const idx = registered.indexOf(s);
    if (idx >= 0) registered.splice(idx, 1);
  };
}

/** Snapshot of currently-registered shortcuts (e.g. for a cheat-sheet UI). */
export function getShortcuts(): readonly Shortcut[] {
  return registered;
}

/**
 * For non-printable / layout-stable keys we ALSO accept a match by `event.code`,
 * because modifiers on macOS munge `event.key` (Option+Space → ' ',
 * Option+letter → composed character, etc.). `code` is the physical-key name
 * and ignores modifiers. We still match printable letters by `key` so users
 * with non-QWERTY layouts get Cmd+Z at the right glyph.
 */
const KEY_CODE_MAP: Readonly<Record<string, string>> = {
  ' ':          'Space',
  tab:          'Tab',
  enter:        'Enter',
  escape:       'Escape',
  backspace:    'Backspace',
  delete:       'Delete',
  arrowup:      'ArrowUp',
  arrowdown:    'ArrowDown',
  arrowleft:    'ArrowLeft',
  arrowright:   'ArrowRight',
  pageup:       'PageUp',
  pagedown:     'PageDown',
  home:         'Home',
  end:          'End',
};

/** True iff every modifier on `s` matches the event's modifier state exactly. */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const expectedCode = KEY_CODE_MAP[s.key];
  const keyMatches = e.key.toLowerCase() === s.key;
  const codeMatches = expectedCode !== undefined && e.code === expectedCode;
  if (!keyMatches && !codeMatches) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!s.mod !== mod) return false;
  if (!!s.shift !== e.shiftKey) return false;
  if (!!s.alt !== e.altKey) return false;
  if (s.when && !s.when()) return false;
  return true;
}

/**
 * Looser match used on keyup: matches by key/code only and ignores modifiers.
 * Mods can change between keydown and keyup (user grabs Shift mid-hold) but
 * the user still expects the release action to fire.
 */
function matchesKeyOnly(e: KeyboardEvent, s: Shortcut): boolean {
  const expectedCode = KEY_CODE_MAP[s.key];
  const keyMatches = e.key.toLowerCase() === s.key;
  const codeMatches = expectedCode !== undefined && e.code === expectedCode;
  return keyMatches || codeMatches;
}

/**
 * Install window-level keydown + keyup listeners that run matching shortcuts.
 * Returns a cleanup function. We always call `preventDefault` on a match so
 * the browser's own action doesn't fight ours.
 *
 * Auto-repeat keydowns are passed through to ordinary shortcuts (so holding
 * an arrow key keeps moving the cursor) but suppressed for shortcuts that
 * declare a `runUp` — those are press-and-hold bindings whose `run` should
 * fire exactly once per real press.
 */
export function installShortcuts(target: Window = window): () => void {
  const downHandler = (ev: Event) => {
    const e = ev as KeyboardEvent;
    for (const s of registered) {
      if (!matchesShortcut(e, s)) continue;
      e.preventDefault();
      if (s.runUp && e.repeat) return;
      s.run();
      return;
    }
  };
  const upHandler = (ev: Event) => {
    const e = ev as KeyboardEvent;
    for (const s of registered) {
      if (!s.runUp) continue;
      if (!matchesKeyOnly(e, s)) continue;
      e.preventDefault();
      s.runUp();
      return;
    }
  };
  target.addEventListener('keydown', downHandler);
  target.addEventListener('keyup', upHandler);
  return () => {
    target.removeEventListener('keydown', downHandler);
    target.removeEventListener('keyup', upHandler);
  };
}
