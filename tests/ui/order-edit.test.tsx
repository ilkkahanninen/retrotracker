import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR, cursor } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { emptyPattern, emptySong } from '../../src/core/mod/format';
import type { Song } from '../../src/core/mod/types';

/** A song with N patterns and orders [0, 1, …, N-1]. */
function songWith(numPatterns: number): Song {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = numPatterns;
  for (let i = 0; i < numPatterns; i++) s.orders[i] = i;
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
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

describe('order list: click navigation', () => {
  it('clicking a slot moves the cursor onto that order, row 0', async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>('.orderlist li');
    expect(items).toHaveLength(3);
    await user.click(items[2]!);
    expect(cursor()).toMatchObject({ order: 2, row: 0 });
  });

  it('the cursor slot carries .orderlist__item--cursor when stopped', async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    const items = container.querySelectorAll<HTMLElement>('.orderlist li');
    await user.click(items[1]!);
    expect(items[1]!.classList.contains('orderlist__item--cursor')).toBe(true);
    expect(items[0]!.classList.contains('orderlist__item--cursor')).toBe(false);
  });
});

describe('order list: < / > step pattern at slot', () => {
  it("'>' increments orders[cursor.order]", async () => {
    setSong(songWith(3));
    render(() => <App />);
    const user = userEvent.setup();
    expect(song()!.orders[0]).toBe(0);
    await user.keyboard('{Shift>}.{/Shift}'); // > = Shift+.
    expect(song()!.orders[0]).toBe(1);
  });

  it("'<' decrements orders[cursor.order] and clamps at 0", async () => {
    setSong(songWith(3));
    render(() => <App />);
    const user = userEvent.setup();
    setCursor({ order: 2, row: 0, channel: 0, field: 'note' }); // slot 2 → pattern 2
    await user.keyboard('{Shift>},{/Shift}'); // < = Shift+,
    expect(song()!.orders[2]).toBe(1);
    await user.keyboard('{Shift>},{/Shift}');
    expect(song()!.orders[2]).toBe(0);
    await user.keyboard('{Shift>},{/Shift}');
    expect(song()!.orders[2]).toBe(0); // clamped
  });

  it("'>' auto-grows the patterns array when stepping past the last existing one", async () => {
    setSong(songWith(2)); // 2 patterns
    render(() => <App />);
    const user = userEvent.setup();
    setCursor({ order: 1, row: 0, channel: 0, field: 'note' }); // slot 1 → pattern 1
    await user.keyboard('{Shift>}.{/Shift}');
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[1]).toBe(2);
  });
});

describe('order list: insert / delete slot', () => {
  it('Cmd+I inserts a new slot at the cursor and bumps songLength', async () => {
    setSong(songWith(2));
    render(() => <App />);
    const user = userEvent.setup();
    expect(song()!.songLength).toBe(2);
    await user.keyboard('{Meta>}i{/Meta}');
    expect(song()!.songLength).toBe(3);
    expect(song()!.orders[0]).toBe(0); // duplicated from the previous slot 0
    expect(song()!.orders[1]).toBe(0);
    expect(song()!.orders[2]).toBe(1); // old slot 1 pushed right
  });

  it('Cmd+D deletes the slot under the cursor and shrinks songLength', async () => {
    setSong(songWith(3));
    render(() => <App />);
    const user = userEvent.setup();
    setCursor({ order: 1, row: 0, channel: 0, field: 'note' });
    await user.keyboard('{Meta>}d{/Meta}');
    expect(song()!.songLength).toBe(2);
    expect(song()!.orders[1]).toBe(2); // the previous slot 2 pulled left
  });

  it('Cmd+D clamps the cursor when deleting the last slot', async () => {
    setSong(songWith(2));
    render(() => <App />);
    const user = userEvent.setup();
    setCursor({ order: 1, row: 0, channel: 0, field: 'note' });
    await user.keyboard('{Meta>}d{/Meta}');
    expect(song()!.songLength).toBe(1);
    expect(cursor().order).toBe(0);
  });

  it('Cmd+D no-ops when the song already has only one slot', async () => {
    setSong(songWith(1));
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}d{/Meta}');
    expect(song()!.songLength).toBe(1);
  });
});

describe('order list: new blank pattern at slot', () => {
  it('Cmd+B appends a new pattern and points the slot at it', async () => {
    setSong(songWith(2));
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}b{/Meta}');
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
  });
});

describe('order list: duplicate pattern at slot', () => {
  it('Cmd+Shift+B copies the current pattern and points the slot at the copy', async () => {
    const s = songWith(2);
    s.patterns[0]!.rows[3]![1] = { period: 428, sample: 5, effect: 0xC, effectParam: 0x40 };
    setSong(s);
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}{Shift>}b{/Shift}{/Meta}');
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
    const copied = song()!.patterns[2]!.rows[3]![1]!;
    expect(copied.period).toBe(428);
    expect(copied.sample).toBe(5);
    expect(copied.effect).toBe(0xC);
    expect(copied.effectParam).toBe(0x40);
  });
});

describe('order editing is suppressed during playback', () => {
  it("'>' is a no-op while transport is playing", async () => {
    setSong(songWith(3));
    render(() => <App />);
    const user = userEvent.setup();
    setTransport('playing');
    await user.keyboard('{Shift>}.{/Shift}');
    expect(song()!.orders[0]).toBe(0);
  });
});

/**
 * Toolbar parity: the buttons in `.ordertools` should drive the same
 * mutations the keyboard does. We don't re-test every edge case (the
 * mutations are unit-tested separately) — just the click → state path
 * for each action and the disabled-state contract.
 */
function tool(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    `.ordertools button[aria-label="${label}"]`,
  );
  if (!btn) throw new Error(`tool button "${label}" not found`);
  return btn;
}

describe('order toolbar buttons', () => {
  it('Next button increments the slot pattern', async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    expect(song()!.orders[0]).toBe(0);
    await user.click(tool(container, 'Next pattern at slot'));
    expect(song()!.orders[0]).toBe(1);
  });

  it('Previous button decrements and is disabled at pattern 0', async () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    // Slot 0 → pattern 0 → button disabled.
    expect(tool(container, 'Previous pattern at slot').disabled).toBe(true);
    setCursor({ order: 2, row: 0, channel: 0, field: 'note' });
    expect(tool(container, 'Previous pattern at slot').disabled).toBe(false);
    await user.click(tool(container, 'Previous pattern at slot'));
    expect(song()!.orders[2]).toBe(1);
  });

  it('Insert button grows songLength', async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, 'Insert slot'));
    expect(song()!.songLength).toBe(3);
  });

  it('Insert advances the cursor onto the newly-created slot', async () => {
    setSong(songWith(3));
    setCursor({ order: 1, row: 0, channel: 0, field: 'note' });
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, 'Insert slot'));
    // [0,1,2] with cursor on 1 → [0,1,1,2]; the new (duplicate) slot is at
    // index 2 and the cursor advances there.
    expect(cursor().order).toBe(2);
    expect(song()!.orders.slice(0, 4)).toEqual([0, 1, 1, 2]);
  });

  it('Insert via Cmd+I at MAX_ORDERS leaves the cursor put (no-op insertOrder)', () => {
    // The toolbar button gates on `songLength < 128` so it disables itself,
    // but the Cmd+I shortcut only checks transport — without our songLength
    // before/after diff the handler would still bump the cursor on a no-op
    // insert, walking it past content. Drive the keyboard path (via a raw
    // KeyboardEvent — `userEvent.keyboard` has heavy realtime delays we
    // don't need here) so we hit exactly that branch.
    const s = emptySong();
    s.songLength = 128;
    for (let i = 0; i < 128; i++) s.orders[i] = 0;
    setSong(s);
    setCursor({ order: 5, row: 0, channel: 0, field: 'note' });
    render(() => <App />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true }));
    expect(cursor().order).toBe(5);
    expect(song()!.songLength).toBe(128);
  });

  it('Delete button shrinks songLength and disables at length 1', async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, 'Delete slot'));
    expect(song()!.songLength).toBe(1);
    expect(tool(container, 'Delete slot').disabled).toBe(true);
  });

  it('New blank button appends a pattern and points the slot at it', async () => {
    setSong(songWith(2));
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, 'New blank pattern'));
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
  });

  it('Duplicate button copies the current pattern and points the slot at the copy', async () => {
    const s = songWith(2);
    s.patterns[0]!.rows[7]![2] = { period: 320, sample: 3, effect: 0, effectParam: 0 };
    setSong(s);
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(tool(container, 'Duplicate pattern'));
    expect(song()!.patterns).toHaveLength(3);
    expect(song()!.orders[0]).toBe(2);
    expect(song()!.patterns[2]!.rows[7]![2]!.period).toBe(320);
    expect(song()!.patterns[2]!.rows[7]![2]!.sample).toBe(3);
  });

  it('every toolbar button is disabled while transport is playing', () => {
    setSong(songWith(3));
    const { container } = render(() => <App />);
    setTransport('playing');
    for (const label of [
      'Previous pattern at slot',
      'Next pattern at slot',
      'Insert slot',
      'Delete slot',
      'New blank pattern',
      'Duplicate pattern',
    ]) {
      expect(tool(container, label).disabled).toBe(true);
    }
  });
});
