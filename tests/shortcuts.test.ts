import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHORTCUTS, installShortcuts, matchesShortcut, type Shortcut } from '../src/state/shortcuts';
import {
  canRedo, canUndo, clearHistory, commitEdit, setSong, song,
} from '../src/state/song';
import { emptySong } from '../src/core/mod/format';

function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => {},
    ...init,
  } as unknown as KeyboardEvent;
}

describe('matchesShortcut', () => {
  const undoShortcut: Shortcut = { key: 'z', mod: true, description: 'Undo', run: () => {} };
  const redoShortcut: Shortcut = { key: 'z', mod: true, shift: true, description: 'Redo', run: () => {} };

  it('matches Cmd+Z to Undo', () => {
    expect(matchesShortcut(ev({ key: 'z', metaKey: true }), undoShortcut)).toBe(true);
  });

  it('matches Ctrl+Z to Undo (cross-platform mod)', () => {
    expect(matchesShortcut(ev({ key: 'z', ctrlKey: true }), undoShortcut)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesShortcut(ev({ key: 'Z', metaKey: true }), undoShortcut)).toBe(true);
  });

  it('does not match Cmd+Shift+Z to Undo', () => {
    expect(matchesShortcut(ev({ key: 'z', metaKey: true, shiftKey: true }), undoShortcut)).toBe(false);
  });

  it('matches Cmd+Shift+Z to Redo', () => {
    expect(matchesShortcut(ev({ key: 'z', metaKey: true, shiftKey: true }), redoShortcut)).toBe(true);
  });

  it('does not match plain Z (no modifier)', () => {
    expect(matchesShortcut(ev({ key: 'z' }), undoShortcut)).toBe(false);
  });
});

describe('SHORTCUTS list', () => {
  it('exposes Undo and Redo bindings', () => {
    const descriptions = SHORTCUTS.map(s => s.description);
    expect(descriptions).toContain('Undo');
    expect(descriptions).toContain('Redo');
  });
});

describe('installShortcuts', () => {
  beforeEach(() => {
    setSong(null);
    clearHistory();
  });
  afterEach(() => {
    setSong(null);
    clearHistory();
  });

  /** Minimal stand-in for `window` covering only the methods we use. */
  function makeFakeWindow() {
    let listener: ((e: Event) => void) | null = null;
    const w = {
      addEventListener: (_type: string, l: EventListener) => {
        listener = l as (e: Event) => void;
      },
      removeEventListener: (_type: string, l: EventListener) => {
        if (listener === (l as unknown as (e: Event) => void)) listener = null;
      },
      dispatch: (init: Partial<KeyboardEvent>) => listener?.(ev(init) as unknown as Event),
    };
    return w;
  }

  it('runs Undo when Cmd+Z is dispatched', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);

    setSong(emptySong());
    commitEdit((s) => ({ ...s, title: 'edited' }));
    expect(canUndo()).toBe(true);

    w.dispatch({ key: 'z', metaKey: true });

    expect(song()!.title).toBe('');
    expect(canRedo()).toBe(true);
    cleanup();
  });

  it('runs Redo on Cmd+Shift+Z and on Cmd+Y', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);

    setSong(emptySong());
    commitEdit((s) => ({ ...s, title: 'A' }));
    commitEdit((s) => ({ ...s, title: 'B' }));
    w.dispatch({ key: 'z', metaKey: true });
    w.dispatch({ key: 'z', metaKey: true });
    expect(song()!.title).toBe('');

    w.dispatch({ key: 'z', metaKey: true, shiftKey: true });
    expect(song()!.title).toBe('A');

    w.dispatch({ key: 'y', metaKey: true });
    expect(song()!.title).toBe('B');
    cleanup();
  });

  it('removes the listener when cleanup is called', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);
    cleanup();

    setSong(emptySong());
    commitEdit((s) => ({ ...s, title: 'edited' }));
    w.dispatch({ key: 'z', metaKey: true });

    // Listener detached, so undo was not invoked.
    expect(song()!.title).toBe('edited');
  });
});
