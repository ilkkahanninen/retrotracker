import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import { PatternGrid } from '../../src/components/PatternGrid';
import { setCursor, INITIAL_CURSOR, type Cursor } from '../../src/state/cursor';
import { emptyPattern, emptySong, PERIOD_TABLE } from '../../src/core/mod/format';
import type { Song } from '../../src/core/mod/types';

function songFixture(): Song {
  const s = emptySong();
  s.title = 'ui-test';
  s.patterns = [emptyPattern()];
  s.songLength = 1;
  s.orders[0] = 0;
  // Row 5 / channel 0: C-2 with sample 0x1F.
  const cell = s.patterns[0]!.rows[5]![0]!;
  cell.period = PERIOD_TABLE[0]![12]!; // C-2
  cell.sample = 0x1F;
  return s;
}

beforeEach(() => {
  setCursor({ ...INITIAL_CURSOR });
});

afterEach(() => cleanup());

describe('PatternGrid rendering', () => {
  it('virtualizes: spacer reflects the full pattern, only the visible slice renders', () => {
    // The grid renders only the buffer of rows around the viewport; the
    // spacer's height proves it tracks all 64 rows. (jsdom reports
    // clientHeight=0 so the slice is just the buffer's worth.)
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    expect(container.querySelector('.patgrid__header')).not.toBeNull();
    const spacer = container.querySelector<HTMLElement>('.patgrid__rows-spacer')!;
    // 64 rows × 19px = 1216px.
    expect(spacer.style.height).toBe('1216px');
    const rows = container.querySelectorAll('.patgrid__row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(64);
  });

  it('marks the playhead row with --active during playback', () => {
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 5 }} active={true} />
    ));
    const rows = container.querySelectorAll<HTMLElement>('.patgrid__row');
    expect(rows[5]!.classList.contains('patgrid__row--active')).toBe(true);
    expect(rows[4]!.classList.contains('patgrid__row--active')).toBe(false);
  });

  it('marks the playhead row with --cursor when stopped', () => {
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 5 }} active={false} />
    ));
    const rows = container.querySelectorAll<HTMLElement>('.patgrid__row');
    expect(rows[5]!.classList.contains('patgrid__row--cursor')).toBe(true);
    expect(rows[5]!.classList.contains('patgrid__row--active')).toBe(false);
  });

  it('renders the sample number as two separately-styled nibbles', () => {
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const sampSpan = row5.querySelector<HTMLElement>('.patgrid__samp')!;
    const chars = sampSpan.querySelectorAll<HTMLElement>('.patgrid__samp-char');
    expect(chars).toHaveLength(2);
    expect(chars[0]!.textContent).toBe('1'); // hi nibble
    expect(chars[1]!.textContent).toBe('F'); // lo nibble
  });

  it('places the field cursor on the correct sample nibble', () => {
    setCursor({ order: 0, row: 5, channel: 0, field: 'sampleLo' });
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 5 }} active={false} />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const chars = row5.querySelectorAll<HTMLElement>('.patgrid__samp-char');
    expect(chars[0]!.classList.contains('patgrid__field--cursor')).toBe(false);
    expect(chars[1]!.classList.contains('patgrid__field--cursor')).toBe(true);
  });

  it('hides the field cursor entirely while playing', () => {
    setCursor({ order: 0, row: 5, channel: 0, field: 'sampleLo' });
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={true} />
    ));
    expect(container.querySelector('.patgrid__field--cursor')).toBeNull();
  });

  it('renders an empty sample as ".." dots', () => {
    const s = songFixture();
    s.patterns[0]!.rows[3]![0]!.period = PERIOD_TABLE[0]![12]!; // note but no sample
    const { container } = render(() => (
      <PatternGrid song={s} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row3 = container.querySelectorAll<HTMLElement>('.patgrid__row')[3]!;
    const chars = row3.querySelectorAll<HTMLElement>('.patgrid__samp-char');
    expect(chars[0]!.textContent).toBe('.');
    expect(chars[1]!.textContent).toBe('.');
  });

  it('renders an empty effect column as "..." dots when the cursor is elsewhere', () => {
    setCursor({ order: 0, row: 5, channel: 0, field: 'note' });
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const ch0 = row5.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!;
    const chars = ch0.querySelectorAll<HTMLElement>('.patgrid__eff-char');
    expect(chars).toHaveLength(3);
    for (const c of chars) expect(c.textContent).toBe('.');
  });

  it('shows effect digits "000" when the cursor is on the effect column of an otherwise-empty cell', () => {
    // Regression: typing arpeggio (effect 0xy) starts by setting effect=0
    // on effectCmd — but effect=0 + effectParam=0 IS the empty-cell state,
    // so the user got no visual feedback for the first keystroke. Now that
    // the cursor is past effectCmd (at effectHi after the entry advance)
    // we force the digits to render so the user sees the "0" they typed.
    setCursor({ order: 0, row: 5, channel: 0, field: 'effectHi' });
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const ch0 = row5.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!;
    const chars = ch0.querySelectorAll<HTMLElement>('.patgrid__eff-char');
    expect(chars[0]!.textContent).toBe('0');
    expect(chars[1]!.textContent).toBe('0');
    expect(chars[2]!.textContent).toBe('0');
  });

  it('still uses dots on rows whose cursor sits on a different cell-field', () => {
    // Cursor is on the effect column of channel 0; channel 1's effect column
    // should not light up (different cell), still rendering as dots.
    setCursor({ order: 0, row: 5, channel: 0, field: 'effectCmd' });
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const cells = row5.querySelectorAll<HTMLElement>('.patgrid__cell');
    const ch1Eff = cells[1]!.querySelectorAll<HTMLElement>('.patgrid__eff-char');
    for (const c of ch1Eff) expect(c.textContent).toBe('.');
  });
});

describe('PatternGrid cell click', () => {
  // The cell handlers fire on mousedown (not click) because they ALSO
  // anchor a drag selection; using click would lose the drag intent on
  // the way back up. Tests fire mouseDown to match that contract.
  it('clicking the note column reports the cursor position with field=note', () => {
    const onCellClick = vi.fn<(c: Cursor) => void>();
    const { container } = render(() => (
      <PatternGrid
        song={songFixture()} pos={{ order: 0, row: 0 }} active={false}
        onCellClick={onCellClick}
      />
    ));
    const row3 = container.querySelectorAll<HTMLElement>('.patgrid__row')[3]!;
    const cells = row3.querySelectorAll<HTMLElement>('.patgrid__cell');
    // Channel 2's note span — verifies the (row, channel, field) decoding.
    fireEvent.mouseDown(cells[2]!.querySelector('.patgrid__note')!);
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellClick).toHaveBeenCalledWith({
      order: 0, row: 3, channel: 2, field: 'note',
    });
  });

  it('clicking a sample nibble reports field=sampleHi or sampleLo', () => {
    const onCellClick = vi.fn<(c: Cursor) => void>();
    const { container } = render(() => (
      <PatternGrid
        song={songFixture()} pos={{ order: 0, row: 0 }} active={false}
        onCellClick={onCellClick}
      />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const chars = row5.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!
      .querySelectorAll<HTMLElement>('.patgrid__samp-char');
    fireEvent.mouseDown(chars[0]!);
    fireEvent.mouseDown(chars[1]!);
    expect(onCellClick).toHaveBeenNthCalledWith(1, {
      order: 0, row: 5, channel: 0, field: 'sampleHi',
    });
    expect(onCellClick).toHaveBeenNthCalledWith(2, {
      order: 0, row: 5, channel: 0, field: 'sampleLo',
    });
  });

  it('clicking each effect nibble reports the matching field', () => {
    const onCellClick = vi.fn<(c: Cursor) => void>();
    const { container } = render(() => (
      <PatternGrid
        song={songFixture()} pos={{ order: 0, row: 0 }} active={false}
        onCellClick={onCellClick}
      />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const effChars = row5.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!
      .querySelectorAll<HTMLElement>('.patgrid__eff-char');
    fireEvent.mouseDown(effChars[0]!);
    fireEvent.mouseDown(effChars[1]!);
    fireEvent.mouseDown(effChars[2]!);
    expect(onCellClick.mock.calls.map(([c]) => c.field)).toEqual([
      'effectCmd', 'effectHi', 'effectLo',
    ]);
  });

  it('clicking a cell\'s padding (outside any character) falls back to the note field', () => {
    // The cell-level fallback handler — clicking the wrapping
    // .patgrid__cell directly (not bubbling from a child) reports field=note.
    const onCellClick = vi.fn<(c: Cursor) => void>();
    const { container } = render(() => (
      <PatternGrid
        song={songFixture()} pos={{ order: 0, row: 0 }} active={false}
        onCellClick={onCellClick}
      />
    ));
    const row3 = container.querySelectorAll<HTMLElement>('.patgrid__row')[3]!;
    fireEvent.mouseDown(row3.querySelectorAll<HTMLElement>('.patgrid__cell')[1]!);
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellClick).toHaveBeenCalledWith({
      order: 0, row: 3, channel: 1, field: 'note',
    });
  });

  it('a child-field click does not also fire the cell-level fallback', () => {
    // stopPropagation on each field span keeps the cell-level handler from
    // double-firing — without it, a click on .patgrid__samp-char would
    // bubble up and re-fire as field=note.
    const onCellClick = vi.fn<(c: Cursor) => void>();
    const { container } = render(() => (
      <PatternGrid
        song={songFixture()} pos={{ order: 0, row: 0 }} active={false}
        onCellClick={onCellClick}
      />
    ));
    const row5 = container.querySelectorAll<HTMLElement>('.patgrid__row')[5]!;
    const sampLo = row5.querySelectorAll<HTMLElement>('.patgrid__cell')[0]!
      .querySelectorAll<HTMLElement>('.patgrid__samp-char')[1]!;
    fireEvent.mouseDown(sampLo);
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellClick.mock.calls[0]![0].field).toBe('sampleLo');
  });

  it('omitting onCellClick is fine — clicks are silent no-ops', () => {
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const row3 = container.querySelectorAll<HTMLElement>('.patgrid__row')[3]!;
    expect(() => fireEvent.click(row3.querySelector('.patgrid__note')!)).not.toThrow();
  });
});
