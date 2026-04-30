import { describe, expect, it } from 'vitest';
import { deleteCellPullUp, insertCellPushDown, setCell } from '../src/core/mod/mutations';
import { emptyPattern, emptySong } from '../src/core/mod/format';
import type { Song } from '../src/core/mod/types';

function makeSong(): Song {
  const s = emptySong();
  s.patterns = [emptyPattern(), emptyPattern()];
  s.songLength = 2;
  s.orders[0] = 0;
  s.orders[1] = 1;
  return s;
}

describe('setCell', () => {
  it('writes the patch into the addressed cell', () => {
    const s = makeSong();
    const next = setCell(s, 1, 5, 2, { period: 428, sample: 7 });
    const cell = next.patterns[1]!.rows[5]![2]!;
    expect(cell.period).toBe(428);
    expect(cell.sample).toBe(7);
  });

  it('preserves untouched fields on the cell', () => {
    const s = makeSong();
    s.patterns[0]!.rows[0]![0] = { period: 0, sample: 0, effect: 0xC, effectParam: 0x40 };
    const next = setCell(s, 0, 0, 0, { period: 428 });
    const cell = next.patterns[0]!.rows[0]![0]!;
    expect(cell.period).toBe(428);
    expect(cell.effect).toBe(0xC);
    expect(cell.effectParam).toBe(0x40);
  });

  it('returns a new Song reference', () => {
    const s = makeSong();
    const next = setCell(s, 0, 0, 0, { period: 428 });
    expect(next).not.toBe(s);
  });

  it('shares unchanged patterns by reference (structural sharing)', () => {
    const s = makeSong();
    const next = setCell(s, 0, 0, 0, { period: 428 });
    // Pattern 1 wasn't touched, so the reference should be the same.
    expect(next.patterns[1]).toBe(s.patterns[1]);
    // Pattern 0 was modified, so it must be a new object.
    expect(next.patterns[0]).not.toBe(s.patterns[0]);
  });

  it('returns the same Song reference when nothing changes', () => {
    const s = makeSong();
    s.patterns[0]!.rows[0]![0] = { period: 428, sample: 1, effect: 0, effectParam: 0 };
    const next = setCell(s, 0, 0, 0, { period: 428, sample: 1 });
    expect(next).toBe(s);
  });

  it('no-ops on out-of-range row/channel/order', () => {
    const s = makeSong();
    expect(setCell(s, 99, 0, 0, { period: 428 })).toBe(s);
    expect(setCell(s, 0, 99, 0, { period: 428 })).toBe(s);
    expect(setCell(s, 0, 0, 99, { period: 428 })).toBe(s);
    expect(setCell(s, -1, 0, 0, { period: 428 })).toBe(s);
  });
});

describe('deleteCellPullUp', () => {
  function seedChannel(s: Song, order: number, channel: number) {
    const pat = s.patterns[s.orders[order]!]!;
    pat.rows[0]![channel] = { period: 100, sample: 0, effect: 0, effectParam: 0 };
    pat.rows[1]![channel] = { period: 200, sample: 0, effect: 0, effectParam: 0 };
    pat.rows[2]![channel] = { period: 300, sample: 0, effect: 0, effectParam: 0 };
  }

  it('pulls cells below the deleted row up by one and blanks the last row', () => {
    const s = makeSong();
    seedChannel(s, 0, 1);
    const next = deleteCellPullUp(s, 0, 1, 1);
    const pat = next.patterns[0]!;
    expect(pat.rows[0]![1]!.period).toBe(100);   // unchanged
    expect(pat.rows[1]![1]!.period).toBe(300);   // pulled up from row 2
    expect(pat.rows[2]![1]!.period).toBe(0);     // pulled up from row 3 (empty)
    expect(pat.rows[63]![1]!.period).toBe(0);    // last row blanked
  });

  it('leaves other channels referentially equal', () => {
    const s = makeSong();
    seedChannel(s, 0, 1);
    const next = deleteCellPullUp(s, 0, 0, 1);
    const before = s.patterns[0]!;
    const after = next.patterns[0]!;
    for (let r = 0; r < 64; r++) {
      expect(after.rows[r]![0]!).toBe(before.rows[r]![0]!);
      expect(after.rows[r]![2]!).toBe(before.rows[r]![2]!);
      expect(after.rows[r]![3]!).toBe(before.rows[r]![3]!);
    }
  });

  it('leaves other patterns referentially equal', () => {
    const s = makeSong();
    seedChannel(s, 0, 1);
    const next = deleteCellPullUp(s, 0, 0, 1);
    expect(next.patterns[1]).toBe(s.patterns[1]);
  });

  it('no-ops on out-of-range row/channel/order', () => {
    const s = makeSong();
    expect(deleteCellPullUp(s, 99, 0, 0)).toBe(s);
    expect(deleteCellPullUp(s, 0, 99, 0)).toBe(s);
    expect(deleteCellPullUp(s, 0, 0, 99)).toBe(s);
  });
});

describe('insertCellPushDown', () => {
  function seedChannel(s: Song, order: number, channel: number) {
    const pat = s.patterns[s.orders[order]!]!;
    pat.rows[0]![channel] = { period: 100, sample: 0, effect: 0, effectParam: 0 };
    pat.rows[1]![channel] = { period: 200, sample: 0, effect: 0, effectParam: 0 };
    pat.rows[2]![channel] = { period: 300, sample: 0, effect: 0, effectParam: 0 };
    pat.rows[63]![channel] = { period: 999, sample: 0, effect: 0, effectParam: 0 };
  }

  it('inserts empty at row and pushes existing cells down by one', () => {
    const s = makeSong();
    seedChannel(s, 0, 2);
    const next = insertCellPushDown(s, 0, 1, 2);
    const pat = next.patterns[0]!;
    expect(pat.rows[0]![2]!.period).toBe(100);   // unchanged
    expect(pat.rows[1]![2]!.period).toBe(0);     // newly inserted empty
    expect(pat.rows[2]![2]!.period).toBe(200);   // pushed down from row 1
    expect(pat.rows[3]![2]!.period).toBe(300);   // pushed down from row 2
  });

  it('drops the last row of the channel', () => {
    const s = makeSong();
    seedChannel(s, 0, 2);
    const next = insertCellPushDown(s, 0, 0, 2);
    expect(next.patterns[0]!.rows[63]![2]!.period).not.toBe(999);
  });

  it('leaves other channels referentially equal', () => {
    const s = makeSong();
    seedChannel(s, 0, 2);
    const next = insertCellPushDown(s, 0, 0, 2);
    const before = s.patterns[0]!;
    const after = next.patterns[0]!;
    for (let r = 0; r < 64; r++) {
      expect(after.rows[r]![0]!).toBe(before.rows[r]![0]!);
      expect(after.rows[r]![1]!).toBe(before.rows[r]![1]!);
      expect(after.rows[r]![3]!).toBe(before.rows[r]![3]!);
    }
  });

  it('no-ops on out-of-range row/channel/order', () => {
    const s = makeSong();
    expect(insertCellPushDown(s, 99, 0, 0)).toBe(s);
    expect(insertCellPushDown(s, 0, 99, 0)).toBe(s);
    expect(insertCellPushDown(s, 0, 0, 99)).toBe(s);
  });
});
