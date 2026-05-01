import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR, cursor } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';

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

/** Read the cell at (order=0, row, channel=0). */
function cellAt(row: number) {
  const s = song();
  if (!s) throw new Error('no song mounted');
  const patNum = s.orders[0]!;
  return s.patterns[patNum]!.rows[row]![0]!;
}

/** Move the cursor onto the named field of (order=0, row=0, channel=0). */
function placeCursor(field: ReturnType<typeof cursor>['field']) {
  setCursor({ order: 0, row: 0, channel: 0, field });
}

describe('effect entry: single-nibble writes', () => {
  it('digit on effectCmd sets the command and advances to effectHi', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c'); // 0xC = SetVolume
    expect(cellAt(0).effect).toBe(0xC);
    expect(cellAt(0).effectParam).toBe(0);
    expect(cursor()).toMatchObject({ row: 0, field: 'effectHi' });
  });

  it('digit on effectHi sets the high nibble and advances to effectLo', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectHi');
    await user.keyboard('4');
    expect(cellAt(0).effectParam).toBe(0x40);
    expect(cursor().field).toBe('effectLo');
  });

  it('digit on effectLo sets the low nibble and advances to next row', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectLo');
    await user.keyboard('a');
    expect(cellAt(0).effectParam).toBe(0x0A);
    expect(cursor()).toMatchObject({ row: 1, channel: 0, field: 'effectLo' });
  });
});

describe('effect entry: three-digit chord "C40" (set-volume 64)', () => {
  it('typing c, 4, 0 in sequence yields effect=0xC, param=0x40', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');
    expect(cellAt(0).effect).toBe(0xC);
    expect(cellAt(0).effectParam).toBe(0x40);
    // Cursor moved cmd → hi → lo → (down) → row 1, effectLo.
    expect(cursor()).toMatchObject({ row: 1, field: 'effectLo' });
  });
});

describe('effect entry: nibble independence', () => {
  it('overwriting effectCmd preserves effectParam', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40'); // effect=C param=0x40
    placeCursor('effectCmd');
    await user.keyboard('5');    // effect=5; param should still be 0x40
    expect(cellAt(0).effect).toBe(0x5);
    expect(cellAt(0).effectParam).toBe(0x40);
  });

  it('overwriting effectHi preserves effectLo nibble', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');  // param=0x40
    placeCursor('effectHi');
    await user.keyboard('a');     // hi → A; lo (=0) preserved → 0xA0
    expect(cellAt(0).effectParam).toBe(0xA0);
  });

  it('overwriting effectLo preserves effectHi nibble', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');  // param=0x40
    placeCursor('effectLo');
    await user.keyboard('f');     // lo → F; hi (=4) preserved → 0x4F
    expect(cellAt(0).effectParam).toBe(0x4F);
  });
});

describe('effect entry: clear (".") on effect fields', () => {
  it('. on effectCmd nukes both effect and param', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');     // effect=C param=0x40
    placeCursor('effectCmd');
    await user.keyboard('.');
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
  });

  it('. on effectHi clears only the high nibble of param', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');     // param=0x40
    placeCursor('effectHi');
    await user.keyboard('.');
    expect(cellAt(0).effectParam).toBe(0x00); // hi cleared, lo was 0 already
    expect(cellAt(0).effect).toBe(0xC);        // cmd untouched
  });
});

describe('effect entry: rendering', () => {
  it('a written effect appears as separate cmd / hi / lo characters', async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    await user.keyboard('c40');
    const row0 = container.querySelectorAll<HTMLElement>('.patgrid__row')[0]!;
    // Scope to channel 0 — each row carries one .patgrid__cell per channel.
    const ch0 = row0.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!;
    const effChars = ch0.querySelectorAll<HTMLElement>('.patgrid__eff-char');
    expect(effChars).toHaveLength(3);
    expect(effChars[0]!.textContent).toBe('C');
    expect(effChars[1]!.textContent).toBe('4');
    expect(effChars[2]!.textContent).toBe('0');
  });
});

describe('effect entry: respects the "no edit while playing" rule', () => {
  it('hex digits on effectCmd are no-ops during playback', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor('effectCmd');
    setTransport('playing');
    await user.keyboard('c');
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
  });
});
