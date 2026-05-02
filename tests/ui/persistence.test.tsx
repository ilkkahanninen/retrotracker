import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSession, loadSession, clearSession } from '../../src/state/persistence';
import { emptyPattern, emptySong, PERIOD_TABLE } from '../../src/core/mod/format';
import type { Song } from '../../src/core/mod/types';

const STORAGE_KEY = 'retrotracker:session:v1';

beforeEach(() => clearSession());
afterEach(() => clearSession());

function songWithStamps(): Song {
  const s = emptySong();
  s.title = 'persisted';
  s.patterns = [emptyPattern()];
  s.songLength = 1;
  s.orders[0] = 0;
  // Drop a recognisable cell so we can verify the parse round-trip.
  s.patterns[0]!.rows[5]![0] = {
    period: PERIOD_TABLE[0]![12]!, sample: 7, effect: 0xC, effectParam: 0x40,
  };
  // Stamp some sample data so the binary path covers a non-zero sample chunk.
  s.samples[0]!.name = 'kick';
  s.samples[0]!.lengthWords = 4;
  s.samples[0]!.data = new Int8Array([1, -1, 64, -64, 32, -32, 0, 127]);
  return s;
}

const baseInputs = (song: Song) => ({
  song,
  filename: 'demo.mod',
  view: 'pattern' as const,
  cursor: { order: 0, row: 5, channel: 1, field: 'sampleHi' as const },
  currentSample: 7,
  currentOctave: 3,
  editStep: 4,
});

describe('saveSession / loadSession round-trip', () => {
  it('restores the song bytes via writeModule + parseModule', () => {
    const song = songWithStamps();
    saveSession(baseInputs(song));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.song.title).toBe('persisted');
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.period).toBe(PERIOD_TABLE[0]![12]!);
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.effectParam).toBe(0x40);
    expect(loaded!.song.samples[0]!.name).toBe('kick');
    expect(loaded!.song.samples[0]!.lengthWords).toBe(4);
    expect(Array.from(loaded!.song.samples[0]!.data)).toEqual([1, -1, 64, -64, 32, -32, 0, 127]);
  });

  it('restores filename / view / cursor / current sample / octave / editStep verbatim', () => {
    saveSession(baseInputs(songWithStamps()));
    const loaded = loadSession()!;
    expect(loaded.filename).toBe('demo.mod');
    expect(loaded.view).toBe('pattern');
    expect(loaded.cursor).toEqual({ order: 0, row: 5, channel: 1, field: 'sampleHi' });
    expect(loaded.currentSample).toBe(7);
    expect(loaded.currentOctave).toBe(3);
    expect(loaded.editStep).toBe(4);
  });

  it('round-trips an empty song', () => {
    saveSession({
      song: emptySong(), filename: null, view: 'sample',
      cursor: { order: 0, row: 0, channel: 0, field: 'note' },
      currentSample: 1, currentOctave: 2, editStep: 1,
    });
    const loaded = loadSession()!;
    expect(loaded.filename).toBeNull();
    expect(loaded.view).toBe('sample');
    expect(loaded.song.songLength).toBe(1);
  });
});

describe('loadSession: missing / corrupt input', () => {
  it('returns null when nothing is stored', () => {
    expect(loadSession()).toBeNull();
  });

  it('returns null on non-JSON garbage', () => {
    localStorage.setItem(STORAGE_KEY, '<not json>');
    expect(loadSession()).toBeNull();
  });

  it('returns null when the version field is missing or wrong', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 99, songBase64: '' }));
    expect(loadSession()).toBeNull();
  });

  it('returns null when the song base64 fails to parse as a .mod', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      songBase64: btoa('not a real .mod'),
      filename: null, view: 'pattern',
      cursor: { order: 0, row: 0, channel: 0, field: 'note' },
      currentSample: 1, currentOctave: 2, editStep: 1,
    }));
    expect(loadSession()).toBeNull();
  });

  it('returns null on shape mismatch (missing fields)', () => {
    // No cursor, no currentSample — fails the type guard.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1, songBase64: 'abc', filename: null, view: 'pattern',
    }));
    expect(loadSession()).toBeNull();
  });
});

describe('loadSession: validation clamps wild values', () => {
  function storeWith(partial: Record<string, unknown>) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      songBase64: '',
      filename: null,
      view: 'pattern',
      cursor: { order: 0, row: 0, channel: 0, field: 'note' },
      currentSample: 1, currentOctave: 2, editStep: 1,
      ...partial,
    }));
  }

  it('clamps cursor row / channel / order to valid ranges', () => {
    saveSession({
      song: emptySong(), filename: null, view: 'pattern',
      cursor: { order: 999, row: -5, channel: 17, field: 'note' },
      currentSample: 1, currentOctave: 2, editStep: 1,
    });
    const loaded = loadSession()!;
    expect(loaded.cursor.order).toBe(127);
    expect(loaded.cursor.row).toBe(0);
    expect(loaded.cursor.channel).toBe(3);
  });

  it('falls back to "note" when cursor.field is unknown', () => {
    saveSession({
      song: emptySong(), filename: null, view: 'pattern',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cursor: { order: 0, row: 0, channel: 0, field: 'wat' as any },
      currentSample: 1, currentOctave: 2, editStep: 1,
    });
    expect(loadSession()!.cursor.field).toBe('note');
  });

  it('clamps currentSample / currentOctave / editStep to their ranges', () => {
    saveSession({
      song: emptySong(), filename: null, view: 'pattern',
      cursor: { order: 0, row: 0, channel: 0, field: 'note' },
      currentSample: 999, currentOctave: 99, editStep: 999,
    });
    const loaded = loadSession()!;
    expect(loaded.currentSample).toBe(31);
    expect(loaded.currentOctave).toBe(3);
    expect(loaded.editStep).toBe(16);
  });

  it('rejects unknown view values (not just "pattern" / "sample") via shape guard', () => {
    storeWith({ view: 'something-else' });
    // The type guard fails on a bad view → loadSession returns null.
    expect(loadSession()).toBeNull();
  });
});

describe('clearSession', () => {
  it('removes the stored payload', () => {
    saveSession(baseInputs(songWithStamps()));
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    clearSession();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadSession()).toBeNull();
  });
});

describe('App boot: restores from localStorage on mount', () => {
  // Lazy-imported so the module-level signal resets in between top-level
  // describes don't leak across file-level state. The render() call mounts
  // App which reads the persisted session in onMount.
  it('uses the stored song / view / cursor instead of the empty default', async () => {
    const { render, cleanup } = await import('@solidjs/testing-library');
    const { App } = await import('../../src/App');
    const { song, setSong, setTransport, setPlayPos, clearHistory } = await import('../../src/state/song');
    const { setCursor, INITIAL_CURSOR, cursor } = await import('../../src/state/cursor');
    const { setCurrentSample, setCurrentOctave, setEditStep, currentSample, currentOctave, editStep } =
      await import('../../src/state/edit');
    const { setView, view } = await import('../../src/state/view');

    // Reset every signal to its boot default so the test starts from a
    // realistic "fresh page load" state.
    setSong(null);
    setPlayPos({ order: 0, row: 0 });
    setTransport('idle');
    clearHistory();
    setCursor({ ...INITIAL_CURSOR });
    setCurrentSample(1);
    setCurrentOctave(2);
    setEditStep(1);
    setView('pattern');

    // Stash a session before App mounts.
    saveSession({
      song: songWithStamps(),
      filename: 'restored.mod',
      view: 'sample',
      cursor: { order: 0, row: 11, channel: 2, field: 'effectHi' },
      currentSample: 5, currentOctave: 3, editStep: 3,
    });

    render(() => <App />);
    // App's onMount runs synchronously after render; the persisted state
    // should already be present on the relevant signals.
    expect(song()!.title).toBe('persisted');
    expect(view()).toBe('sample');
    expect(cursor()).toEqual({ order: 0, row: 11, channel: 2, field: 'effectHi' });
    expect(currentSample()).toBe(5);
    expect(currentOctave()).toBe(3);
    expect(editStep()).toBe(3);

    cleanup();
  });
});
