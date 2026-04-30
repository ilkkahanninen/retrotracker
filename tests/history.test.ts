import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  clearHistory,
  commitEdit,
  redo,
  setSong,
  setTransport,
  song,
  undo,
} from '../src/state/song';
import { emptySong } from '../src/core/mod/format';

function makeSong(title: string) {
  const s = emptySong();
  s.title = title;
  return s;
}

describe('song history', () => {
  beforeEach(() => {
    setSong(null);
    clearHistory();
  });
  afterEach(() => {
    setSong(null);
    clearHistory();
  });

  it('commits a new state and reports canUndo', () => {
    setSong(makeSong('A'));
    expect(canUndo()).toBe(false);

    commitEdit((s) => ({ ...s, title: 'B' }));

    expect(song()!.title).toBe('B');
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it('undoes back to the prior snapshot', () => {
    setSong(makeSong('A'));
    commitEdit((s) => ({ ...s, title: 'B' }));

    undo();

    expect(song()!.title).toBe('A');
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
  });

  it('redoes after an undo', () => {
    setSong(makeSong('A'));
    commitEdit((s) => ({ ...s, title: 'B' }));
    undo();
    redo();

    expect(song()!.title).toBe('B');
    expect(canRedo()).toBe(false);
  });

  it('clears the redo stack on a fresh commit', () => {
    setSong(makeSong('A'));
    commitEdit((s) => ({ ...s, title: 'B' }));
    undo();
    expect(canRedo()).toBe(true);

    commitEdit((s) => ({ ...s, title: 'C' }));

    expect(canRedo()).toBe(false);
    expect(song()!.title).toBe('C');
  });

  it('skips no-op transforms that return the same reference', () => {
    setSong(makeSong('A'));
    commitEdit((s) => s);
    expect(canUndo()).toBe(false);
  });

  it('does nothing if no song is loaded', () => {
    commitEdit((s) => ({ ...s, title: 'B' }));
    expect(song()).toBeNull();
    expect(canUndo()).toBe(false);
  });

  it('caps the history at HISTORY_LIMIT entries', () => {
    setSong(makeSong('start'));
    const overshoot = 50;
    for (let i = 0; i < HISTORY_LIMIT + overshoot; i++) {
      commitEdit((s) => ({ ...s, title: String(i) }));
    }
    let undos = 0;
    while (canUndo()) {
      undo();
      undos++;
      if (undos > HISTORY_LIMIT + overshoot + 5) throw new Error('runaway undo');
    }
    expect(undos).toBe(HISTORY_LIMIT);
  });

  it('clearHistory wipes both stacks', () => {
    setSong(makeSong('A'));
    commitEdit((s) => ({ ...s, title: 'B' }));
    undo();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);

    clearHistory();

    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  describe('playback gate', () => {
    afterEach(() => setTransport('idle'));

    it('commitEdit is a no-op while playing', () => {
      setSong(makeSong('A'));
      setTransport('playing');
      commitEdit((s) => ({ ...s, title: 'B' }));
      expect(song()!.title).toBe('A');
      expect(canUndo()).toBe(false);
    });

    it('undo is a no-op while playing', () => {
      setSong(makeSong('A'));
      commitEdit((s) => ({ ...s, title: 'B' }));
      setTransport('playing');
      undo();
      expect(song()!.title).toBe('B');
      expect(canUndo()).toBe(true);
    });

    it('redo is a no-op while playing', () => {
      setSong(makeSong('A'));
      commitEdit((s) => ({ ...s, title: 'B' }));
      undo();
      setTransport('playing');
      redo();
      expect(song()!.title).toBe('A');
      expect(canRedo()).toBe(true);
    });
  });
});
