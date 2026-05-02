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
  it('renders one row per pattern row plus a header', () => {
    const { container } = render(() => (
      <PatternGrid song={songFixture()} pos={{ order: 0, row: 0 }} active={false} />
    ));
    const rows = container.querySelectorAll('.patgrid__row');
    expect(rows.length).toBe(64);
    expect(container.querySelector('.patgrid__header')).not.toBeNull();
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
});

describe('PatternGrid cell click', () => {
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
    fireEvent.click(cells[2]!.querySelector('.patgrid__note')!);
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
    fireEvent.click(chars[0]!);
    fireEvent.click(chars[1]!);
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
    fireEvent.click(effChars[0]!);
    fireEvent.click(effChars[1]!);
    fireEvent.click(effChars[2]!);
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
    fireEvent.click(row3.querySelectorAll<HTMLElement>('.patgrid__cell')[1]!);
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
    fireEvent.click(sampLo);
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
