import { describe, expect, it } from 'vitest';
import {
  deleteCellPullUp, insertCellPushDown, setCell,
  setOrderPattern, nextPatternAtOrder, prevPatternAtOrder,
  insertOrder, deleteOrder, newPatternAtOrder, duplicatePatternAtOrder,
  setSample, clearSample, replaceSampleData,
} from '../src/core/mod/mutations';
import { emptyPattern, emptySong } from '../src/core/mod/format';
import { MAX_ORDERS } from '../src/core/mod/types';
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

describe('setOrderPattern', () => {
  it('updates the pattern number at the given slot', () => {
    const s = makeSong();
    const next = setOrderPattern(s, 0, 1);
    expect(next.orders[0]).toBe(1);
  });

  it('returns the same reference when the slot already points there', () => {
    const s = makeSong();
    expect(setOrderPattern(s, 0, 0)).toBe(s);
  });

  it('no-ops when the target pattern does not exist', () => {
    const s = makeSong();
    expect(setOrderPattern(s, 0, 99)).toBe(s);
  });

  it('no-ops on an out-of-range order', () => {
    const s = makeSong();
    expect(setOrderPattern(s, 99, 0)).toBe(s);
    expect(setOrderPattern(s, -1, 0)).toBe(s);
  });
});

describe('nextPatternAtOrder', () => {
  it('increments the pattern number when a higher one already exists', () => {
    const s = makeSong(); // 2 patterns; orders [0, 1]
    const next = nextPatternAtOrder(s, 0);
    expect(next.orders[0]).toBe(1);
    expect(next.patterns).toBe(s.patterns); // no auto-grow needed
  });

  it('auto-grows by appending an empty pattern when the slot is at the edge', () => {
    const s = makeSong(); // patterns: 0..1
    const next = nextPatternAtOrder(s, 1); // slot 1 currently at pattern 1
    expect(next.patterns).toHaveLength(3);
    expect(next.orders[1]).toBe(2);
  });
});

describe('prevPatternAtOrder', () => {
  it('decrements the pattern number at the slot', () => {
    const s = makeSong();
    const next = prevPatternAtOrder(s, 1);
    expect(next.orders[1]).toBe(0);
  });

  it('clamps at 0', () => {
    const s = makeSong();
    expect(prevPatternAtOrder(s, 0)).toBe(s);
  });
});

describe('insertOrder', () => {
  it('shifts later slots right and duplicates the current slot at the insertion point', () => {
    const s = makeSong(); // orders [0, 1]
    const next = insertOrder(s, 1);
    expect(next.songLength).toBe(3);
    expect(next.orders[0]).toBe(0);
    expect(next.orders[1]).toBe(1); // newly-inserted, mirrors the previous slot 1
    expect(next.orders[2]).toBe(1); // the old slot 1 was pushed right
  });

  it('inserting at the end appends a duplicate of the last slot', () => {
    const s = makeSong();
    const next = insertOrder(s, 2);
    expect(next.songLength).toBe(3);
    expect(next.orders[2]).toBe(0); // emptySong()'s orders[2] is the slot we duplicated
  });

  it('no-ops at MAX_ORDERS', () => {
    const s = makeSong();
    s.songLength = MAX_ORDERS;
    expect(insertOrder(s, 0)).toBe(s);
  });
});

describe('deleteOrder', () => {
  it('pulls subsequent slots left and shrinks songLength', () => {
    const s = makeSong(); // orders [0, 1]
    const next = deleteOrder(s, 0);
    expect(next.songLength).toBe(1);
    expect(next.orders[0]).toBe(1);
  });

  it('no-ops when songLength is already 1', () => {
    const s = emptySong(); // length 1
    expect(deleteOrder(s, 0)).toBe(s);
  });
});

describe('newPatternAtOrder', () => {
  it('appends an empty pattern and points the slot at it', () => {
    const s = makeSong();
    const next = newPatternAtOrder(s, 0);
    expect(next.patterns).toHaveLength(3);
    expect(next.orders[0]).toBe(2);
    // The freshly-created pattern has all empty rows.
    expect(next.patterns[2]!.rows[0]![0]!.period).toBe(0);
  });

  it('leaves the previously-pointed-to pattern intact (other slots may share it)', () => {
    const s = makeSong(); // orders [0, 1]
    s.orders[1] = 0; // slot 1 also points at pattern 0
    const next = newPatternAtOrder(s, 0);
    expect(next.orders[1]).toBe(0); // untouched
    expect(next.patterns[0]).toBe(s.patterns[0]); // shared by reference
  });
});

describe('duplicatePatternAtOrder', () => {
  it('appends a copy of the current pattern and points the slot at it', () => {
    const s = makeSong();
    // Stamp something distinctive in pattern 0 so we can verify the copy.
    s.patterns[0]!.rows[3]![1] = { period: 428, sample: 5, effect: 0xC, effectParam: 0x40 };
    const next = duplicatePatternAtOrder(s, 0);
    expect(next.patterns).toHaveLength(3);
    expect(next.orders[0]).toBe(2);
    const copied = next.patterns[2]!.rows[3]![1]!;
    expect(copied.period).toBe(428);
    expect(copied.sample).toBe(5);
    expect(copied.effect).toBe(0xC);
    expect(copied.effectParam).toBe(0x40);
  });

  it('produces a distinct rows array — editing the copy via setCell does not affect the source', () => {
    const s = makeSong();
    s.patterns[0]!.rows[0]![0] = { period: 428, sample: 0, effect: 0, effectParam: 0 };
    const dupSong = duplicatePatternAtOrder(s, 0); // duplicates pattern 0 → pattern 2, slot 0 → 2
    // Edit the copy via the same path the UI uses.
    const after = setCell(dupSong, 0, 0, 0, { period: 320 });
    // Source pattern's cell is unchanged.
    expect(after.patterns[0]!.rows[0]![0]!.period).toBe(428);
    expect(after.patterns[2]!.rows[0]![0]!.period).toBe(320);
  });

  it('leaves other slots that referenced the source pattern still pointing at it', () => {
    const s = makeSong();
    s.orders[1] = 0; // both slots point at pattern 0
    const next = duplicatePatternAtOrder(s, 0);
    expect(next.orders[0]).toBe(2); // duplicated → new pattern
    expect(next.orders[1]).toBe(0); // untouched
  });

  it('no-ops on an out-of-range order', () => {
    const s = makeSong();
    expect(duplicatePatternAtOrder(s, 99)).toBe(s);
    expect(duplicatePatternAtOrder(s, -1)).toBe(s);
  });
});

describe('setSample', () => {
  it('patches the named fields and leaves the rest alone', () => {
    const s = makeSong();
    s.samples[0]!.name = 'kick';
    s.samples[0]!.volume = 32;
    s.samples[0]!.finetune = 0;
    const next = setSample(s, 0, { volume: 50, finetune: 3 });
    expect(next.samples[0]!.name).toBe('kick');
    expect(next.samples[0]!.volume).toBe(50);
    expect(next.samples[0]!.finetune).toBe(3);
  });

  it('returns the same Song reference when nothing actually changed', () => {
    const s = makeSong();
    s.samples[0]!.volume = 32;
    expect(setSample(s, 0, { volume: 32 })).toBe(s);
  });

  it('no-ops on an out-of-range slot', () => {
    const s = makeSong();
    expect(setSample(s, 99, { volume: 50 })).toBe(s);
    expect(setSample(s, -1, { volume: 50 })).toBe(s);
  });
});

describe('clearSample', () => {
  it('resets a populated slot to empty', () => {
    const s = makeSong();
    s.samples[0] = {
      name: 'kick', lengthWords: 8, finetune: 3, volume: 50,
      loopStartWords: 0, loopLengthWords: 1,
      data: new Int8Array(16),
    };
    const next = clearSample(s, 0);
    expect(next.samples[0]!.lengthWords).toBe(0);
    expect(next.samples[0]!.name).toBe('');
    expect(next.samples[0]!.volume).toBe(0);
    expect(next.samples[0]!.data.byteLength).toBe(0);
  });

  it('no-ops on an already-empty slot', () => {
    const s = makeSong();
    expect(clearSample(s, 0)).toBe(s);
  });
});

describe('replaceSampleData', () => {
  it('writes new data, recomputes lengthWords, resets loop, applies metadata', () => {
    const s = makeSong();
    const data = new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes = 4 words
    const next = replaceSampleData(s, 0, data, { name: 'snare', volume: 64, finetune: 2 });
    expect(next.samples[0]!.data).toBe(data);
    expect(next.samples[0]!.lengthWords).toBe(4);
    expect(next.samples[0]!.name).toBe('snare');
    expect(next.samples[0]!.volume).toBe(64);
    expect(next.samples[0]!.finetune).toBe(2);
    // Loop reset to "no loop".
    expect(next.samples[0]!.loopStartWords).toBe(0);
    expect(next.samples[0]!.loopLengthWords).toBe(1);
  });

  it('pads odd-length input by one trailing zero byte', () => {
    const s = makeSong();
    const data = new Int8Array([10, 20, 30]); // 3 bytes
    const next = replaceSampleData(s, 0, data);
    expect(next.samples[0]!.data.byteLength).toBe(4);
    expect(next.samples[0]!.lengthWords).toBe(2);
    expect(next.samples[0]!.data[3]).toBe(0); // pad
    expect(next.samples[0]!.data[0]).toBe(10);
  });

  it('caps inputs longer than PT\'s 16-bit lengthWords field', () => {
    const s = makeSong();
    const big = new Int8Array(200_000); // > 65535 words = 131070 bytes
    const next = replaceSampleData(s, 0, big);
    expect(next.samples[0]!.lengthWords).toBe(65535);
    expect(next.samples[0]!.data.byteLength).toBe(65535 * 2);
  });
});
