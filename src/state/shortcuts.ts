import { redo, undo } from './song';

/**
 * Keyboard shortcut bindings.
 *
 * Add new shortcuts to the SHORTCUTS list. Each entry declares its
 * modifiers and the action; the install function below sets up a single
 * window-level keydown listener that dispatches to the matching entry.
 *
 * Conventions:
 *   - `mod: true` means ⌘ on macOS, Ctrl on Windows/Linux (matches what
 *     users actually expect on each platform — KeyboardEvent gives both).
 *   - `key` is matched case-insensitively against `KeyboardEvent.key`.
 *   - `description` is human-readable and will drive a cheat-sheet UI later.
 */
export interface Shortcut {
  /** Lower-case key (e.g. 'z', 'enter', 'arrowup'). */
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  run: () => void;
}

export const SHORTCUTS: Shortcut[] = [
  { key: 'z', mod: true,             description: 'Undo', run: undo },
  { key: 'z', mod: true, shift: true, description: 'Redo', run: redo },
  { key: 'y', mod: true,             description: 'Redo', run: redo },
];

/** True iff every modifier on `s` matches the event's modifier state exactly. */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  if (e.key.toLowerCase() !== s.key) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!s.mod !== mod) return false;
  if (!!s.shift !== e.shiftKey) return false;
  if (!!s.alt !== e.altKey) return false;
  return true;
}

/**
 * Install a window-level keydown listener that runs the matching shortcut.
 * Returns a cleanup function. If a shortcut matches we always call
 * `preventDefault` so the browser's own action (e.g. its edit-menu Undo)
 * doesn't fight ours, even if our handler is currently a no-op.
 */
export function installShortcuts(target: Window = window): () => void {
  const handler = (ev: Event) => {
    const e = ev as KeyboardEvent;
    for (const s of SHORTCUTS) {
      if (!matchesShortcut(e, s)) continue;
      e.preventDefault();
      s.run();
      return;
    }
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}
