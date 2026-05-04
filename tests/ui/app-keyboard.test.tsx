import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR, cursor } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song, transport } from '../../src/state/song';
import { setCurrentOctave } from '../../src/state/edit';
import { Effect, PERIOD_TABLE } from '../../src/core/mod/format';
import { selection, clearSelection } from '../../src/state/selection';

/**
 * Reset every module-level signal that App's mounted state writes into,
 * so tests don't bleed into each other. App's `onMount` reseeds `song`
 * with `emptySong()` on first render, but only when `song()` is null.
 */
function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentOctave(2);
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Read the cell under the current cursor — convenience for assertions. */
function cellAtCursor() {
  const c = cursor();
  const s = song();
  if (!s) throw new Error('no song mounted');
  const patNum = s.orders[c.order]!;
  return s.patterns[patNum]!.rows[c.row]![c.channel]!;
}

describe('App: cursor navigation', () => {
  it('Right walks the cursor through fields in left-to-right order', async () => {
    render(() => <App />);
    const user = userEvent.setup();

    // Cursor starts on note. Six fields per channel, then wraps to next channel.
    const order: ReturnType<typeof cursor>['field'][] = [
      'sampleHi', 'sampleLo', 'effectCmd', 'effectHi', 'effectLo',
    ];
    for (const expected of order) {
      await user.keyboard('{ArrowRight}');
      expect(cursor().field).toBe(expected);
    }
    // One more right wraps to channel 1, note.
    await user.keyboard('{ArrowRight}');
    expect(cursor()).toMatchObject({ channel: 1, field: 'note' });
  });

  it('Down advances the row (cursor stays on the same field/channel)', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // sampleHi
    await user.keyboard('{ArrowDown}');
    expect(cursor()).toMatchObject({ row: 1, channel: 0, field: 'sampleHi' });
  });
});

describe('App: hex digit entry on sample nibbles', () => {
  it("press '1' on sampleHi sets the high nibble and advances to sampleLo", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // → sampleHi
    await user.keyboard('1');
    expect(cellAtCursor().sample).toBe(0x10);
    expect(cursor().field).toBe('sampleLo');
    expect(cursor().row).toBe(0); // same row
  });

  it("press 'f' on sampleLo sets the low nibble and advances to next row", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}{ArrowRight}'); // → sampleLo
    await user.keyboard('f');
    // Field stays on sampleLo, row steps down by one.
    expect(cursor()).toMatchObject({ row: 1, channel: 0, field: 'sampleLo' });
    // The digit was written at the previous row; peek back to verify.
    setCursor({ order: 0, row: 0, channel: 0, field: 'sampleLo' });
    expect(cellAtCursor().sample).toBe(0x0F);
  });

  it('two-digit entry: "1f" yields sample 0x1F', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // sampleHi
    await user.keyboard('1');             // sample = 0x10, cursor → sampleLo
    await user.keyboard('f');             // sample = 0x1F, cursor → row 1 sampleLo
    setCursor({ ...cursor(), row: 0 });   // peek back at the edited cell
    expect(cellAtCursor().sample).toBe(0x1F);
  });

  it('clamps at 31 (PT 5-bit limit) when raw value would exceed it', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // sampleHi
    // 'a' = digit 10, raw = 0xA0 = 160, clamped to 31.
    await user.keyboard('a');
    setCursor({ ...cursor(), row: 0, field: 'sampleHi' });
    expect(cellAtCursor().sample).toBe(31);
  });
});

describe('App: piano vs hex routing on shared keys', () => {
  it("'a' on the note field plays piano-C (writes a period), not hex 0xA", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    expect(cursor().field).toBe('note');
    await user.keyboard('a'); // C in current octave (default 2 → noteIndex 12 → period 428)
    setCursor({ ...cursor(), row: 0 }); // step back; note entry advanced the cursor
    const cell = cellAtCursor();
    expect(cell.period).toBe(PERIOD_TABLE[0]![12]!);
    expect(cell.sample).toBeGreaterThan(0); // current sample stamped in
  });

  it("'a' on sampleHi is treated as hex 0xA, not piano", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // sampleHi
    await user.keyboard('a');
    setCursor({ ...cursor(), row: 0, field: 'sampleHi' });
    const cell = cellAtCursor();
    expect(cell.period).toBe(0); // no piano action
    // 0xA0 clamped to 31 by the 5-bit limit.
    expect(cell.sample).toBe(31);
  });
});

describe('App: Backspace clears the cursor field', () => {
  it("'.' clears the high nibble of sample, preserving the low nibble", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    // Set sample to 0x1A.
    await user.keyboard('{ArrowRight}'); // sampleHi
    await user.keyboard('1');             // sample = 0x10
    await user.keyboard('a');             // sample = 0x1A; cursor advances to row 1
    setCursor({ order: 0, row: 0, channel: 0, field: 'sampleHi' });
    expect(cellAtCursor().sample).toBe(0x1A);

    await user.keyboard('.'); // clearAtCursor on sampleHi → keep lo, drop hi
    setCursor({ order: 0, row: 0, channel: 0, field: 'sampleHi' });
    expect(cellAtCursor().sample).toBe(0x0A);
  });
});

describe('App: Dxx-truncated patterns', () => {
  // Two regressions reported together — both around a pattern that's been
  // shortened by a Dxx (Pattern Break) in the cursor's column.
  function setDxxAt(row: number, channel: number, nextRow = 0): void {
    const s = song();
    if (!s) throw new Error('no song mounted');
    const cell = s.patterns[s.orders[0]!]!.rows[row]![channel]!;
    cell.effect = Effect.PatternBreak;
    cell.effectParam = ((Math.floor(nextRow / 10) & 0xf) << 4) | (nextRow % 10);
    setSong({ ...s }); // bump signal so consumers (e.g. flatten cache) recompute
  }

  it('Backspace on the Dxx-bearing row moves the cursor up by one (not to song start)', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    // Place a Dxx at row 5 of channel 0 → pattern truncates at row 5.
    setDxxAt(5, 0);
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    clearSelection();
    // Park something distinguishable in the row above so we can verify the
    // backspace pulled the Dxx up rather than snapping the cursor.
    const s = song()!;
    s.patterns[s.orders[0]!]!.rows[4]![0]!.period = PERIOD_TABLE[0]![12]!;
    setSong({ ...s });

    await user.keyboard('{Backspace}');
    // Cursor should land at row 4 (the cell just below the deletion was
    // pulled up, taking the Dxx along).
    expect(cursor().row).toBe(4);
    // And the cell at row 4 channel 0 now holds the Dxx that was at row 5.
    const after = song()!;
    expect(after.patterns[after.orders[0]!]!.rows[4]![0]!.effect).toBe(Effect.PatternBreak);
  });

  it('Shift+ArrowDown at the last visible row does not extend selection past truncation', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setDxxAt(5, 0); // pattern truncates at row 5
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    clearSelection();

    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    // Cursor stays at row 5 (clamped to the last visible row of order 0)
    // and the selection — if any — never reaches into hidden territory.
    expect(cursor().row).toBe(5);
    const sel = selection();
    if (sel) {
      expect(sel.endRow).toBeLessThanOrEqual(5);
    }
  });

  it('Shift+PageDown at the last visible row also clamps to the truncation', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setDxxAt(5, 0);
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    clearSelection();

    await user.keyboard('{Shift>}{PageDown}{/Shift}');
    expect(cursor().row).toBe(5);
    const sel = selection();
    if (sel) expect(sel.endRow).toBeLessThanOrEqual(5);
  });

  it('Cmd+A selects only the visible rows of the truncated pattern (channel scope)', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setDxxAt(5, 0);
    setCursor({ order: 0, row: 2, channel: 1, field: 'note' });
    clearSelection();

    await user.keyboard('{Meta>}a{/Meta}');
    const sel = selection();
    expect(sel).not.toBeNull();
    // Step 1: whole current channel — clamped to rows 0..5.
    expect(sel).toMatchObject({
      order: 0,
      startRow: 0,
      endRow: 5,
      startChannel: 1,
      endChannel: 1,
    });
  });

  it('Cmd+A again expands to the whole visible pattern, then no-ops once maximal', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setDxxAt(5, 0);
    setCursor({ order: 0, row: 2, channel: 1, field: 'note' });
    clearSelection();

    await user.keyboard('{Meta>}a{/Meta}'); // step 1: channel
    await user.keyboard('{Meta>}a{/Meta}'); // step 2: whole visible pattern
    expect(selection()).toMatchObject({
      order: 0,
      startRow: 0,
      endRow: 5,
      startChannel: 0,
      endChannel: 3,
    });
    // Step 3: already maximal → identical.
    const before = selection();
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selection()).toEqual(before);
  });
});

describe('App: editing is suppressed during playback', () => {
  it('hex digits do not change the song while transport is "playing"', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowRight}'); // sampleHi
    setTransport('playing');
    await user.keyboard('1');
    setCursor({ order: 0, row: 0, channel: 0, field: 'sampleHi' });
    expect(cellAtCursor().sample).toBe(0);
    expect(transport()).toBe('playing'); // sanity: nothing toggled it back
  });
});
