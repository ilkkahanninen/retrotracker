import { describe, expect, it } from 'vitest';
import { readSlice, clearRange, pasteSlice } from '../src/core/mod/clipboardOps';
import { emptyPattern, emptySong, PERIOD_TABLE, emptyNote } from '../src/core/mod/format';
import type { Note, Song } from '../src/core/mod/types';

/**
 * Build a minimal song with a single pattern at order 0. Cells can be
 * stamped at construction so each test has self-contained fixtures.
 */
function songWithCells(stamps: Array<{ row: number; ch: number; note: Partial<Note> }>): Song {
  const s = emptySong();
  s.patterns = [emptyPattern()];
  s.songLength = 1;
  s.orders[0] = 0;
  for (const { row, ch, note } of stamps) {
    s.patterns[0]!.rows[row]![ch] = { ...emptyNote(), ...note };
  }
  return s;
}

const C2 = PERIOD_TABLE[0]![12]!;
const D2 = PERIOD_TABLE[0]![14]!;
const E2 = PERIOD_TABLE[0]![16]!;

describe('readSlice', () => {
  it('returns a 2-D copy of the requested range', () => {
    const s = songWithCells([
      { row: 1, ch: 0, note: { period: C2, sample: 1 } },
      { row: 1, ch: 1, note: { period: D2, sample: 2 } },
      { row: 2, ch: 0, note: { period: E2, sample: 3, effect: 0xC, effectParam: 0x40 } },
    ]);
    const slice = readSlice(s, {
      order: 0, startRow: 1, endRow: 2, startChannel: 0, endChannel: 1,
    });
    expect(slice).not.toBeNull();
    expect(slice!).toHaveLength(2);
    expect(slice![0]!).toHaveLength(2);
    expect(slice![0]![0]!.period).toBe(C2);
    expect(slice![0]![1]!.period).toBe(D2);
    expect(slice![1]![0]!.effectParam).toBe(0x40);
    expect(slice![1]![1]!.period).toBe(0); // unset cell → empty note
  });

  it('returns FRESH note copies — mutating the slice does not touch the song', () => {
    const s = songWithCells([{ row: 0, ch: 0, note: { period: C2 } }]);
    const slice = readSlice(s, {
      order: 0, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0,
    })!;
    slice[0]![0]!.period = 999;
    expect(s.patterns[0]!.rows[0]![0]!.period).toBe(C2);
  });

  it('returns null on out-of-range orders / unmapped patterns', () => {
    const s = emptySong();
    expect(readSlice(s, { order: -1, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0 })).toBeNull();
    expect(readSlice(s, { order: 99, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0 })).toBeNull();
  });

  it('returns null when the rectangle is empty (end < start)', () => {
    const s = songWithCells([]);
    expect(readSlice(s, { order: 0, startRow: 5, endRow: 4, startChannel: 0, endChannel: 0 })).toBeNull();
    expect(readSlice(s, { order: 0, startRow: 0, endRow: 0, startChannel: 2, endChannel: 1 })).toBeNull();
  });
});

describe('clearRange', () => {
  it('zeroes every cell inside the rectangle', () => {
    const s = songWithCells([
      { row: 1, ch: 0, note: { period: C2 } },
      { row: 1, ch: 1, note: { period: D2 } },
      { row: 2, ch: 0, note: { period: E2 } },
      { row: 5, ch: 0, note: { period: C2 } }, // outside the clear → preserved
    ]);
    const next = clearRange(s, {
      order: 0, startRow: 1, endRow: 2, startChannel: 0, endChannel: 1,
    });
    expect(next.patterns[0]!.rows[1]![0]!.period).toBe(0);
    expect(next.patterns[0]!.rows[1]![1]!.period).toBe(0);
    expect(next.patterns[0]!.rows[2]![0]!.period).toBe(0);
    // Outside the rect — untouched.
    expect(next.patterns[0]!.rows[5]![0]!.period).toBe(C2);
  });

  it('returns the same Song reference on a no-op (unmapped order)', () => {
    const s = emptySong();
    const next = clearRange(s, { order: 99, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0 });
    expect(next).toBe(s);
  });

  it('does not mutate the input Song', () => {
    const s = songWithCells([{ row: 0, ch: 0, note: { period: C2 } }]);
    const before = s.patterns[0]!.rows[0]![0]!.period;
    clearRange(s, { order: 0, startRow: 0, endRow: 0, startChannel: 0, endChannel: 0 });
    expect(s.patterns[0]!.rows[0]![0]!.period).toBe(before);
  });
});

describe('pasteSlice', () => {
  it('stamps the slice at the given (row, channel)', () => {
    const s = songWithCells([]);
    const slice: Note[][] = [
      [{ period: C2, sample: 1, effect: 0, effectParam: 0 }, { period: D2, sample: 2, effect: 0, effectParam: 0 }],
      [{ period: E2, sample: 3, effect: 0xC, effectParam: 0x40 }, emptyNote()],
    ];
    const next = pasteSlice(s, slice, 0, 10, 1);
    expect(next.patterns[0]!.rows[10]![1]!.period).toBe(C2);
    expect(next.patterns[0]!.rows[10]![2]!.period).toBe(D2);
    expect(next.patterns[0]!.rows[11]![1]!.effectParam).toBe(0x40);
    expect(next.patterns[0]!.rows[11]![2]!.period).toBe(0);
  });

  it('clips rows past the bottom of the pattern', () => {
    const s = songWithCells([]);
    const slice: Note[][] = [
      [{ period: C2, sample: 0, effect: 0, effectParam: 0 }],
      [{ period: D2, sample: 0, effect: 0, effectParam: 0 }],
      [{ period: E2, sample: 0, effect: 0, effectParam: 0 }],
    ];
    // Last pattern row is 63; pasting at row 62 fits two rows, the third
    // is clipped silently.
    const next = pasteSlice(s, slice, 0, 62, 0);
    expect(next.patterns[0]!.rows[62]![0]!.period).toBe(C2);
    expect(next.patterns[0]!.rows[63]![0]!.period).toBe(D2);
    // No row 64 — the third slice row simply vanishes, no error.
  });

  it('clips channels past the right edge', () => {
    const s = songWithCells([]);
    const slice: Note[][] = [
      [
        { period: C2, sample: 0, effect: 0, effectParam: 0 },
        { period: D2, sample: 0, effect: 0, effectParam: 0 },
        { period: E2, sample: 0, effect: 0, effectParam: 0 },
      ],
    ];
    // Channels 0..3; pasting 3 cells at ch=2 fits 2 channels (2,3), drops 1.
    const next = pasteSlice(s, slice, 0, 0, 2);
    expect(next.patterns[0]!.rows[0]![2]!.period).toBe(C2);
    expect(next.patterns[0]!.rows[0]![3]!.period).toBe(D2);
    // No channel 4 — the third cell is clipped.
  });

  it('returns the same Song reference for an empty slice', () => {
    const s = songWithCells([]);
    expect(pasteSlice(s, [], 0, 0, 0)).toBe(s);
  });
});
