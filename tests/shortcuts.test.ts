import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getShortcuts, installShortcuts, matchesShortcut, registerShortcut, type Shortcut,
} from '../src/state/shortcuts';
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

describe('position-based shortcuts (event.code matching)', () => {
  // Piano-row "A" registered as position-based: matches the QWERTY-A
  // physical key (KeyA), regardless of what character that key produces.
  const pianoA: Shortcut = { key: 'a', position: true, description: 'piano A', run: () => {} };

  it('matches by event.code on a QWERTY layout (event.key === event.code-letter)', () => {
    expect(matchesShortcut(ev({ key: 'a', code: 'KeyA' }), pianoA)).toBe(true);
  });

  it('matches the same physical key on AZERTY (event.key="q", event.code="KeyA")', () => {
    // AZERTY user pressing the QWERTY-A position: keycap shows Q, but
    // event.code is still 'KeyA' — position-based dispatch must fire.
    expect(matchesShortcut(ev({ key: 'q', code: 'KeyA' }), pianoA)).toBe(true);
  });

  it('does NOT match the AZERTY user pressing the letter A (event.code="KeyQ")', () => {
    // Their physical-A is at QWERTY-Q position, where the piano shortcut
    // does NOT live — position is the only thing that counts.
    expect(matchesShortcut(ev({ key: 'a', code: 'KeyQ' }), pianoA)).toBe(false);
  });

  it('default-mode letter shortcut (Cmd+A) does NOT fire from QWERTY-A position on AZERTY', () => {
    // Cmd+A is character-mode: it should fire ONLY when the user pressed
    // the letter A, not when they pressed the QWERTY-A physical position
    // on a layout where Q sits there.
    const cmdA: Shortcut = { key: 'a', mod: true, description: 'select all', run: () => {} };
    expect(matchesShortcut(ev({ key: 'q', code: 'KeyA', metaKey: true }), cmdA)).toBe(false);
    // It does still fire when the user types A on any layout.
    expect(matchesShortcut(ev({ key: 'a', code: 'KeyQ', metaKey: true }), cmdA)).toBe(true);
  });
});

describe('shortcut registry', () => {
  it('ships with Undo and Redo bindings', () => {
    const descriptions = getShortcuts().map(s => s.description);
    expect(descriptions).toContain('Undo');
    expect(descriptions).toContain('Redo');
  });

  it('registerShortcut adds an entry; the cleanup removes it', () => {
    const before = getShortcuts().length;
    const cleanup = registerShortcut({
      key: 'q', description: 'Test only', run: () => {},
    });
    expect(getShortcuts().length).toBe(before + 1);

    cleanup();
    expect(getShortcuts().length).toBe(before);
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
    const listeners: Record<string, ((e: Event) => void)[]> = { keydown: [], keyup: [] };
    return {
      addEventListener: (type: string, l: EventListener) => {
        listeners[type] ??= [];
        listeners[type]!.push(l as (e: Event) => void);
      },
      removeEventListener: (type: string, l: EventListener) => {
        const arr = listeners[type];
        if (!arr) return;
        const idx = arr.indexOf(l as unknown as (e: Event) => void);
        if (idx >= 0) arr.splice(idx, 1);
      },
      keydown: (init: Partial<KeyboardEvent>) =>
        (listeners.keydown ?? []).forEach((l) => l(ev(init) as unknown as Event)),
      keyup: (init: Partial<KeyboardEvent>) =>
        (listeners.keyup ?? []).forEach((l) => l(ev(init) as unknown as Event)),
      /** Back-compat alias used by existing chord-shortcut tests. */
      dispatch: (init: Partial<KeyboardEvent>) =>
        (listeners.keydown ?? []).forEach((l) => l(ev(init) as unknown as Event)),
    };
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

  it('fires runUp on keyup for press-and-hold shortcuts', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);
    let downs = 0;
    let ups = 0;
    const release = registerShortcut({
      key: 'a', description: 'Test',
      run: () => { downs++; },
      runUp: () => { ups++; },
    });

    w.keydown({ key: 'a' });
    w.keyup({ key: 'a' });
    expect(downs).toBe(1);
    expect(ups).toBe(1);

    release();
    cleanup();
  });

  it('runUp matches keyup ignoring modifiers (user grabs Shift mid-hold)', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);
    let ups = 0;
    const release = registerShortcut({
      key: 'a', description: 'Test', run: () => {}, runUp: () => { ups++; },
    });

    w.keydown({ key: 'a' });
    w.keyup({ key: 'a', shiftKey: true });
    expect(ups).toBe(1);

    release();
    cleanup();
  });

  it('suppresses repeat keydowns for press-and-hold shortcuts', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);
    let downs = 0;
    const release = registerShortcut({
      key: 'a', description: 'Test',
      run: () => { downs++; },
      runUp: () => {},
    });

    w.keydown({ key: 'a' });
    w.keydown({ key: 'a', repeat: true });
    w.keydown({ key: 'a', repeat: true });
    expect(downs).toBe(1);

    release();
    cleanup();
  });

  it('still fires repeat keydowns for ordinary shortcuts (e.g. arrow nav)', () => {
    const w = makeFakeWindow();
    const cleanup = installShortcuts(w as unknown as Window);
    let downs = 0;
    const release = registerShortcut({
      key: 'a', description: 'Test', run: () => { downs++; },
    });

    w.keydown({ key: 'a' });
    w.keydown({ key: 'a', repeat: true });
    w.keydown({ key: 'a', repeat: true });
    expect(downs).toBe(3);

    release();
    cleanup();
  });
});

describe('Space chord shortcuts', () => {
  it('matchesShortcut routes Space + modifier permutations correctly', () => {
    const plain    = { key: ' ',                          description: 'plain',    run: () => {} };
    const alt      = { key: ' ', alt: true,               description: 'alt',      run: () => {} };
    const shift    = { key: ' ', shift: true,             description: 'shift',    run: () => {} };
    const altShift = { key: ' ', alt: true, shift: true,  description: 'altShift', run: () => {} };

    expect(matchesShortcut(ev({ key: ' ' }), plain)).toBe(true);
    expect(matchesShortcut(ev({ key: ' ', altKey: true }), plain)).toBe(false);

    expect(matchesShortcut(ev({ key: ' ', altKey: true }), alt)).toBe(true);
    expect(matchesShortcut(ev({ key: ' ' }), alt)).toBe(false);
    expect(matchesShortcut(ev({ key: ' ', altKey: true, shiftKey: true }), alt)).toBe(false);

    expect(matchesShortcut(ev({ key: ' ', shiftKey: true }), shift)).toBe(true);
    expect(matchesShortcut(ev({ key: ' ', shiftKey: true, altKey: true }), shift)).toBe(false);

    expect(matchesShortcut(ev({ key: ' ', altKey: true, shiftKey: true }), altShift)).toBe(true);
  });

  it('matches by event.code when macOS munges Alt+Space to NBSP', () => {
    const alt = { key: ' ', alt: true, description: 'alt', run: () => {} };
    // Real macOS event for Option+Space: key is U+00A0 (non-breaking space),
    // code stays 'Space'.
    expect(matchesShortcut(ev({ key: ' ', code: 'Space', altKey: true }), alt)).toBe(true);
  });

  it('matches arrow keys by code as well as key', () => {
    const up = { key: 'arrowup', description: 'up', run: () => {} };
    expect(matchesShortcut(ev({ key: 'ArrowUp' }), up)).toBe(true);
    expect(matchesShortcut(ev({ key: 'foo', code: 'ArrowUp' }), up)).toBe(true);
  });

  it('matches Shift + comma/period via event.code on US layouts', () => {
    // On US layout Shift+',' produces event.key '<' (and code 'Comma'); the
    // bare-key match would miss, so we need to match by code. Symmetric
    // case for '.' / '>'.
    const prevPat = { key: ',', shift: true, description: '<', run: () => {} };
    const nextPat = { key: '.', shift: true, description: '>', run: () => {} };
    expect(matchesShortcut(ev({ key: '<', code: 'Comma',  shiftKey: true }), prevPat)).toBe(true);
    expect(matchesShortcut(ev({ key: '>', code: 'Period', shiftKey: true }), nextPat)).toBe(true);
    // Plain ',' / '.' (no shift) doesn't accidentally satisfy the shifted shortcut.
    expect(matchesShortcut(ev({ key: ',', code: 'Comma' }), prevPat)).toBe(false);
  });
});
