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
  // Digits and a couple of OEM punctuation keys: registering a `key: '1', shift: true`
  // shortcut would otherwise miss because `event.key` becomes '!' under shift on
  // US layout. Matching by `event.code` (`Digit1`) catches it regardless.
  '0':          'Digit0',
  '1':          'Digit1',
  '2':          'Digit2',
  '3':          'Digit3',
  '4':          'Digit4',
  '5':          'Digit5',
  '6':          'Digit6',
  '7':          'Digit7',
  '8':          'Digit8',
  '9':          'Digit9',
  '-':          'Minus',
  '=':          'Equal',
  ',':          'Comma',
  '.':          'Period',
  ';':          'Semicolon',
  '/':          'Slash',
  "'":          'Quote',
  '[':          'BracketLeft',
  ']':          'BracketRight',
  '\\':         'Backslash',
  '`':          'Backquote',
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
 * Categorise document.activeElement so the dispatcher can decide *which*
 * shortcuts to skip:
 *   - 'text': text inputs, textareas, contenteditable — block ALL bare-key
 *     shortcuts so typing 'a' enters the letter, doesn't preview a note.
 *   - 'range': range sliders — block only navigation keys (arrows / page /
 *     home / end) so the user keeps native slider interaction, but bare
 *     letters fall through to shortcuts (piano keys, octave Z/X, …).
 *     Range inputs don't consume letters or digits anyway.
 *   - 'select': <select> elements — block bare-key shortcuts (selects can
 *     jump-to-letter on type).
 *   - null: nothing focused or focus is on a non-form element.
 *
 * Mod-key shortcuts (⌘S, ⌘Z, …) always fire regardless, so global app
 * actions stay reachable.
 */
type FocusKind = 'text' | 'range' | 'select' | null;

function focusKind(): FocusKind {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!el) return null;
  if (el instanceof HTMLInputElement && el.type === 'range') return 'range';
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'text';
  if (tag === 'SELECT') return 'select';
  if (el instanceof HTMLElement && el.isContentEditable) return 'text';
  return null;
}

/** Keys a focused range input consumes natively — leave these to the slider. */
const RANGE_NAV_KEYS: ReadonlySet<string> = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'pageup', 'pagedown', 'home', 'end',
]);

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
    const kind = focusKind();
    for (const s of registered) {
      if (!matchesShortcut(e, s)) continue;
      // Mod-key shortcuts (⌘S, ⌘Z, …) always fire — global actions reach
      // the user even while a form control is focused.
      if (!s.mod) {
        // Text inputs / selects consume bare keystrokes; skip plain-key
        // shortcuts so typing into the field works.
        if (kind === 'text' || kind === 'select') continue;
        // Range inputs natively consume navigation keys — let the slider
        // keep arrow/page/home/end. Letters and digits pass through so
        // piano notes (a/s/d/…) audition while the slider has focus.
        if (kind === 'range' && RANGE_NAV_KEYS.has(s.key)) continue;
      }
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
