import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR, cursor } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave, setEditStep } from '../../src/state/edit';
import {
  selection, setSelection, makeSelection, clearSelection,
  selectionAnchor,
} from '../../src/state/selection';
import { clipboardSlice, setClipboardSlice } from '../../src/state/clipboard';
import { emptyPattern, emptySong, PERIOD_TABLE } from '../../src/core/mod/format';
import type { Song, Note } from '../../src/core/mod/types';

const C2 = PERIOD_TABLE[0]![12]!;
const D2 = PERIOD_TABLE[0]![14]!;
const E2 = PERIOD_TABLE[0]![16]!;

function songWith(stamps: Array<{ row: number; ch: number; note: Partial<Note> }>): Song {
  const s = emptySong();
  s.patterns = [emptyPattern()];
  s.songLength = 1;
  s.orders[0] = 0;
  for (const { row, ch, note } of stamps) {
    s.patterns[0]!.rows[row]![ch] = { ...s.patterns[0]!.rows[row]![ch]!, ...note };
  }
  return s;
}

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
  clearSelection();
  setClipboardSlice(null);
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Dispatch a window-level Cmd+key keydown — the App's shortcuts hang off
 *  document.addEventListener('keydown', ...), so this is the cheapest way
 *  to drive a chord without userEvent's realtime delays. */
function chord(key: string, mods: { shift?: boolean } = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key, metaKey: true, shiftKey: mods.shift ?? false,
  }));
}

describe('Cmd+A: select-all cycle', () => {
  it('first press selects the whole CURRENT channel of the cursor\'s pattern', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 7, channel: 2, field: 'note' });
    chord('a');
    const sel = selection();
    expect(sel).not.toBeNull();
    expect(sel!).toEqual({
      order: 0, startRow: 0, endRow: 63, startChannel: 2, endChannel: 2,
    });
  });

  it('second press expands to the WHOLE pattern', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 1, field: 'note' });
    chord('a'); // → channel 1
    chord('a'); // → whole pattern
    expect(selection()).toEqual({
      order: 0, startRow: 0, endRow: 63, startChannel: 0, endChannel: 3,
    });
  });

  it('a third press leaves the whole-pattern selection unchanged', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    chord('a'); chord('a'); chord('a');
    expect(selection()).toEqual({
      order: 0, startRow: 0, endRow: 63, startChannel: 0, endChannel: 3,
    });
  });

  it('starting from an arbitrary drag-selection always lands on step 1 (channel)', () => {
    // The cycle key is the EXACT channel-wide rectangle. Anything else
    // (like a 4×2 drag) should be replaced by the channel-wide select.
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 1, field: 'note' });
    setSelection(makeSelection(0, 1, 0, 8, 3)); // arbitrary
    chord('a');
    expect(selection()).toEqual({
      order: 0, startRow: 0, endRow: 63, startChannel: 1, endChannel: 1,
    });
  });

  it('Cmd+A is suppressed during playback', () => {
    setSong(songWith([]));
    render(() => <App />);
    setTransport('playing');
    chord('a');
    expect(selection()).toBeNull();
  });
});

describe('Cmd+C: copy', () => {
  it('with a selection: copies the rectangle to the clipboard', () => {
    setSong(songWith([
      { row: 1, ch: 0, note: { period: C2, sample: 1 } },
      { row: 1, ch: 1, note: { period: D2, sample: 2 } },
      { row: 2, ch: 0, note: { period: E2, sample: 3 } },
    ]));
    render(() => <App />);
    setSelection(makeSelection(0, 1, 0, 2, 1));
    chord('c');
    const slice = clipboardSlice();
    expect(slice).not.toBeNull();
    expect(slice!.rows).toHaveLength(2);
    expect(slice!.rows[0]![0]!.period).toBe(C2);
    expect(slice!.rows[0]![1]!.period).toBe(D2);
    expect(slice!.rows[1]![0]!.period).toBe(E2);
  });

  it('with NO selection: copies the cursor\'s single cell', () => {
    setSong(songWith([
      { row: 4, ch: 2, note: { period: C2, sample: 7 } },
    ]));
    render(() => <App />);
    setCursor({ order: 0, row: 4, channel: 2, field: 'note' });
    chord('c');
    const slice = clipboardSlice();
    expect(slice).not.toBeNull();
    expect(slice!.rows).toHaveLength(1);
    expect(slice!.rows[0]).toHaveLength(1);
    expect(slice!.rows[0]![0]!.period).toBe(C2);
    expect(slice!.rows[0]![0]!.sample).toBe(7);
  });
});

describe('Cmd+X: cut', () => {
  it('copies the selection AND clears those cells', () => {
    setSong(songWith([
      { row: 1, ch: 0, note: { period: C2 } },
      { row: 2, ch: 0, note: { period: D2 } },
      { row: 5, ch: 0, note: { period: E2 } }, // outside the cut → preserved
    ]));
    render(() => <App />);
    setSelection(makeSelection(0, 1, 0, 2, 0));
    chord('x');
    // Clipboard captured the original notes …
    expect(clipboardSlice()!.rows[0]![0]!.period).toBe(C2);
    expect(clipboardSlice()!.rows[1]![0]!.period).toBe(D2);
    // … and the cells were wiped.
    expect(song()!.patterns[0]!.rows[1]![0]!.period).toBe(0);
    expect(song()!.patterns[0]!.rows[2]![0]!.period).toBe(0);
    // Cell outside the cut is untouched.
    expect(song()!.patterns[0]!.rows[5]![0]!.period).toBe(E2);
    // Selection rectangle is dropped after the cut — the highlighted
    // cells are now empty and a stale rectangle would just confuse.
    expect(selection()).toBeNull();
  });

  it('with no selection cuts just the cursor cell', () => {
    setSong(songWith([{ row: 3, ch: 1, note: { period: C2 } }]));
    render(() => <App />);
    setCursor({ order: 0, row: 3, channel: 1, field: 'note' });
    chord('x');
    expect(clipboardSlice()!.rows[0]![0]!.period).toBe(C2);
    expect(song()!.patterns[0]!.rows[3]![1]!.period).toBe(0);
  });
});

describe('Cmd+V: paste', () => {
  it('stamps the clipboard at the cursor position', () => {
    setSong(songWith([]));
    render(() => <App />);
    setClipboardSlice({ rows: [
      [{ period: C2, sample: 1, effect: 0, effectParam: 0 },
       { period: D2, sample: 2, effect: 0, effectParam: 0 }],
      [{ period: E2, sample: 3, effect: 0xC, effectParam: 0x40 },
       { period: 0,  sample: 0, effect: 0, effectParam: 0 }],
    ] });
    setCursor({ order: 0, row: 10, channel: 1, field: 'note' });
    chord('v');
    expect(song()!.patterns[0]!.rows[10]![1]!.period).toBe(C2);
    expect(song()!.patterns[0]!.rows[10]![2]!.period).toBe(D2);
    expect(song()!.patterns[0]!.rows[11]![1]!.effectParam).toBe(0x40);
  });

  it('is a no-op when the clipboard is empty', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    chord('v');
    // No clipboard → song unchanged.
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(0);
  });

  it('round-trips: copy, move cursor, paste reproduces the original cells', () => {
    setSong(songWith([
      { row: 1, ch: 0, note: { period: C2, sample: 1 } },
      { row: 2, ch: 0, note: { period: D2, sample: 2 } },
    ]));
    render(() => <App />);
    setSelection(makeSelection(0, 1, 0, 2, 0));
    chord('c');
    setCursor({ order: 0, row: 20, channel: 3, field: 'note' });
    chord('v');
    expect(song()!.patterns[0]!.rows[20]![3]!.period).toBe(C2);
    expect(song()!.patterns[0]!.rows[20]![3]!.sample).toBe(1);
    expect(song()!.patterns[0]!.rows[21]![3]!.period).toBe(D2);
    expect(song()!.patterns[0]!.rows[21]![3]!.sample).toBe(2);
  });
});

describe('plain cursor moves drop the selection', () => {
  it('arrow-down clears an active selection', () => {
    setSong(songWith([]));
    const { container } = render(() => <App />);
    setSelection(makeSelection(0, 0, 0, 5, 1));
    expect(selection()).not.toBeNull();
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    expect(selection()).toBeNull();
  });
});

describe('all clipboard shortcuts gate on transport', () => {
  it('Cmd+C / X / V are no-ops while playing', () => {
    setSong(songWith([{ row: 0, ch: 0, note: { period: C2 } }]));
    render(() => <App />);
    setSelection(makeSelection(0, 0, 0, 0, 0));
    setTransport('playing');
    chord('c');
    expect(clipboardSlice()).toBeNull();
    chord('x');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(C2);
    setClipboardSlice({ rows: [[{ period: D2, sample: 0, effect: 0, effectParam: 0 }]] });
    chord('v');
    expect(song()!.patterns[0]!.rows[0]![0]!.period).toBe(C2); // not D2
  });
});

describe('shift+arrow: extend selection from cursor', () => {
  /** Dispatch a window-level Shift+Arrow keydown. */
  function shiftArrow(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'PageUp' | 'PageDown') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true }));
  }

  it('Shift+ArrowDown anchors at the cursor and extends one row down', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 1, field: 'sampleHi' });
    shiftArrow('ArrowDown');
    expect(selectionAnchor()).toEqual({ order: 0, row: 5, channel: 1 });
    expect(selection()).toEqual({
      order: 0, startRow: 5, endRow: 6, startChannel: 1, endChannel: 1,
    });
    expect(cursor()).toMatchObject({ row: 6, channel: 1, field: 'sampleHi' });
  });

  it('successive Shift+ArrowDown presses keep the same anchor and grow the rectangle', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 2, channel: 0, field: 'note' });
    shiftArrow('ArrowDown');
    shiftArrow('ArrowDown');
    shiftArrow('ArrowDown');
    expect(selectionAnchor()).toEqual({ order: 0, row: 2, channel: 0 });
    expect(selection()).toEqual({
      order: 0, startRow: 2, endRow: 5, startChannel: 0, endChannel: 0,
    });
    expect(cursor()).toMatchObject({ row: 5 });
  });

  it('Shift+ArrowRight HOPS to the next channel (skipping all sub-fields)', () => {
    // Plain right walks note→sampleHi→sampleLo→effectCmd→effectHi→effectLo
    // before crossing to the next channel; shift+right jumps a whole
    // channel at a time, so the user's selection covers full channels.
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    shiftArrow('ArrowRight');
    expect(cursor()).toMatchObject({ channel: 1, field: 'note' });
    shiftArrow('ArrowRight');
    expect(cursor()).toMatchObject({ channel: 2, field: 'note' });
    expect(selection()).toEqual({
      order: 0, startRow: 0, endRow: 0, startChannel: 0, endChannel: 2,
    });
  });

  it('Shift+ArrowLeft / Right preserves the cursor field — sub-column doesn\'t change', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 2, field: 'effectHi' });
    shiftArrow('ArrowLeft');
    expect(cursor()).toMatchObject({ channel: 1, field: 'effectHi' });
    shiftArrow('ArrowRight');
    expect(cursor()).toMatchObject({ channel: 2, field: 'effectHi' });
  });

  it('Shift+arrows clamp to pattern bounds', () => {
    // Shift+ArrowUp from row 0 stays at row 0; shift+ArrowLeft from
    // channel 0 stays at channel 0. The selection rectangle is empty in
    // that direction (single row / single channel) but still drawn.
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    shiftArrow('ArrowUp');
    expect(cursor()).toMatchObject({ row: 0, channel: 0 });
    shiftArrow('ArrowLeft');
    expect(cursor()).toMatchObject({ row: 0, channel: 0 });
  });

  it('reversing direction shrinks the rectangle and can flip past the anchor', () => {
    // Anchor at (5, 1). Down twice → (5..7, 1). Then up four → (3..5, 1)
    // (cursor crossed the anchor; the rectangle's normalised bounds
    // contain both endpoints regardless of direction).
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 1, field: 'note' });
    shiftArrow('ArrowDown');
    shiftArrow('ArrowDown');
    expect(selection()).toEqual({
      order: 0, startRow: 5, endRow: 7, startChannel: 1, endChannel: 1,
    });
    shiftArrow('ArrowUp'); shiftArrow('ArrowUp'); shiftArrow('ArrowUp'); shiftArrow('ArrowUp');
    expect(cursor()).toMatchObject({ row: 3 });
    expect(selection()).toEqual({
      order: 0, startRow: 3, endRow: 5, startChannel: 1, endChannel: 1,
    });
  });

  it('Shift+PageDown extends by a full page (rowsPerBeat × beatsPerBar = 16)', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 0, channel: 0, field: 'note' });
    shiftArrow('PageDown');
    expect(cursor()).toMatchObject({ row: 16 });
    expect(selection()).toEqual({
      order: 0, startRow: 0, endRow: 16, startChannel: 0, endChannel: 0,
    });
  });

  it('a plain arrow press AFTER a shift-extension drops the selection AND its anchor', () => {
    setSong(songWith([]));
    const { container } = render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    shiftArrow('ArrowDown');
    shiftArrow('ArrowDown');
    expect(selection()).not.toBeNull();
    expect(selectionAnchor()).not.toBeNull();
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    expect(selection()).toBeNull();
    expect(selectionAnchor()).toBeNull();
  });

  it('shift+arrow after a plain navigation re-anchors at the new cursor', () => {
    // Plain arrow drops selection AND anchor; the next shift-arrow press
    // must therefore set a fresh anchor at the cursor's pre-move spot.
    setSong(songWith([]));
    const { container } = render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    shiftArrow('ArrowDown');                          // anchor (5, 0)
    fireEvent.keyDown(container, { key: 'ArrowDown' }); // plain → cursor (7, 0), no anchor
    shiftArrow('ArrowDown');                          // re-anchor at (7, 0)
    expect(selectionAnchor()).toEqual({ order: 0, row: 7, channel: 0 });
    expect(selection()).toEqual({
      order: 0, startRow: 7, endRow: 8, startChannel: 0, endChannel: 0,
    });
  });

  it('Shift+arrow is suppressed during playback', () => {
    setSong(songWith([]));
    render(() => <App />);
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    setTransport('playing');
    shiftArrow('ArrowDown');
    expect(selection()).toBeNull();
    expect(cursor()).toMatchObject({ row: 5 });
  });
});

describe('cursor advances after paste', () => {
  it('paste lands the cursor on the row right after the pasted block', () => {
    setSong(songWith([]));
    render(() => <App />);
    setClipboardSlice({ rows: [[{ period: C2, sample: 0, effect: 0, effectParam: 0 }]] });
    setCursor({ order: 0, row: 7, channel: 1, field: 'sampleHi' });
    chord('v');
    expect(cursor()).toMatchObject({ row: 8, channel: 1, field: 'sampleHi' });
  });
});
