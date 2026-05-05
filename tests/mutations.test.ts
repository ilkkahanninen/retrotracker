import { describe, expect, it } from 'vitest';
import {
  deleteCellPullUp, insertCellPushDown, setCell,
  setOrderPattern, nextPatternAtOrder, prevPatternAtOrder,
  insertOrder, deleteOrder, newPatternAtOrder, duplicatePatternAtOrder,
  cleanupOrders,
  setSample, clearSample, replaceSampleData, transposeRange,
} from '../src/core/mod/mutations';
import { emptyPattern, emptySong, PERIOD_TABLE } from '../src/core/mod/format';
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

describe('cleanupOrders', () => {
  function songWith(orders: number[], patternCount: number): Song {
    const s = emptySong();
    s.patterns = Array.from({ length: patternCount }, () => emptyPattern());
    s.songLength = orders.length;
    for (let i = 0; i < orders.length; i++) s.orders[i] = orders[i]!;
    return s;
  }

  it('renumbers patterns in order of first appearance and drops the unused ones', () => {
    // The README example: orders [4,5,0,0,1] over six patterns.
    const s = songWith([4, 5, 0, 0, 1], 6);
    // Stamp something distinctive into each pattern so we can verify the
    // post-cleanup pattern bank is the right slice in the right order.
    for (let i = 0; i < s.patterns.length; i++) {
      s.patterns[i]!.rows[0]![0] = { period: 100 + i, sample: 0, effect: 0, effectParam: 0 };
    }
    const { song: next, remap } = cleanupOrders(s);
    expect(next.songLength).toBe(5);
    expect(next.orders.slice(0, 5)).toEqual([0, 1, 2, 2, 3]);
    expect(next.patterns).toHaveLength(4);
    // First-seen pattern (was 4) is now 0, etc.
    expect(next.patterns[0]!.rows[0]![0]!.period).toBe(104);
    expect(next.patterns[1]!.rows[0]![0]!.period).toBe(105);
    expect(next.patterns[2]!.rows[0]![0]!.period).toBe(100);
    expect(next.patterns[3]!.rows[0]![0]!.period).toBe(101);
    // Remap reflects the renumbering and marks the dropped indices undefined.
    expect(remap[4]).toBe(0);
    expect(remap[5]).toBe(1);
    expect(remap[0]).toBe(2);
    expect(remap[1]).toBe(3);
    expect(remap[2]).toBeUndefined();
    expect(remap[3]).toBeUndefined();
  });

  it('zeros the unused tail of the orders array (defensive against stale .mod writes)', () => {
    const s = songWith([4, 5, 0], 6);
    // Simulate a stale value past songLength — `.mod` writes the full 128
    // entries, and we don't want stragglers pointing past trimmed patterns.
    s.orders[100] = 5;
    const { song: next } = cleanupOrders(s);
    expect(next.orders[100]).toBe(0);
  });

  it('returns the same Song reference when nothing would change', () => {
    // Already canonical: orders [0,1,2] over exactly 3 patterns.
    const s = songWith([0, 1, 2], 3);
    const { song: next, remap } = cleanupOrders(s);
    expect(next).toBe(s);
    expect(remap[0]).toBe(0);
    expect(remap[1]).toBe(1);
    expect(remap[2]).toBe(2);
  });

  it('shrinks the pattern bank when patterns past the last referenced index exist', () => {
    // orders are canonical, but pattern 2 is unreferenced — still a cleanup.
    const s = songWith([0, 1], 3);
    const { song: next } = cleanupOrders(s);
    expect(next).not.toBe(s);
    expect(next.patterns).toHaveLength(2);
  });

  it('deduplicates repeated references to the same pattern', () => {
    // [0,0,0] should become orders [0,0,0] over a single pattern.
    const s = songWith([0, 0, 0], 1);
    const { song: next, remap } = cleanupOrders(s);
    expect(next).toBe(s); // already canonical
    expect(remap[0]).toBe(0);
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

  it('shrinking the loop leaves sample.data intact (truncation happens at the playback boundary, not here)', () => {
    const s = makeSong();
    const data = new Int8Array(32);
    for (let i = 0; i < data.length; i++) data[i] = i;
    s.samples[0] = {
      name: 'demo', volume: 64, finetune: 0,
      lengthWords: 16,
      loopStartWords: 0, loopLengthWords: 16,
      data,
    };
    const next = setSample(s, 0, { loopLengthWords: 8 });
    // The full 32 bytes / 16 words of data are preserved — the user can
    // drag the loop end back outward and reach the trailing portion.
    expect(next.samples[0]!.data.byteLength).toBe(32);
    expect(next.samples[0]!.lengthWords).toBe(16);
    expect(next.samples[0]!.loopLengthWords).toBe(8);
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

describe('transposeRange', () => {
  // PERIOD_TABLE row 0 — slot 0 is C-1 (856), slot 12 is C-2 (428),
  // slot 24 is C-3 (214), slot 35 is B-3 (113).
  const F0 = PERIOD_TABLE[0]!;

  function rangeAt(order: number, row: number, channel: number) {
    return { order, startRow: row, endRow: row, startChannel: channel, endChannel: channel };
  }

  it('shifts a single cell up 1 semitone (C-2 → C#-2)', () => {
    const s = makeSong();
    s.patterns[0]!.rows[3]![1]!.period = F0[12]!; // C-2
    const next = transposeRange(s, rangeAt(0, 3, 1), 1);
    expect(next.patterns[0]!.rows[3]![1]!.period).toBe(F0[13]!); // C#-2
  });

  it('shifts a single cell down 1 octave (C-2 → C-1)', () => {
    const s = makeSong();
    s.patterns[0]!.rows[3]![1]!.period = F0[12]!; // C-2
    const next = transposeRange(s, rangeAt(0, 3, 1), -12);
    expect(next.patterns[0]!.rows[3]![1]!.period).toBe(F0[0]!); // C-1
  });

  it('leaves empty cells alone — does not introduce a note from a 0 period', () => {
    const s = makeSong();
    // Cell at (0, 3, 1) starts as period=0.
    const next = transposeRange(s, rangeAt(0, 3, 1), 1);
    expect(next).toBe(s); // no-op returns same reference
  });

  it('clamps at the top of the table — B-3 stays B-3 when transposing up', () => {
    const s = makeSong();
    s.patterns[0]!.rows[3]![1]!.period = F0[35]!; // B-3, top of range
    const next = transposeRange(s, rangeAt(0, 3, 1), 5);
    expect(next.patterns[0]!.rows[3]![1]!.period).toBe(F0[35]!);
  });

  it('clamps at the bottom of the table — C-1 stays C-1 when transposing down', () => {
    const s = makeSong();
    s.patterns[0]!.rows[3]![1]!.period = F0[0]!; // C-1, bottom of range
    const next = transposeRange(s, rangeAt(0, 3, 1), -5);
    expect(next.patterns[0]!.rows[3]![1]!.period).toBe(F0[0]!);
  });

  it('walks every cell inside a multi-channel, multi-row selection', () => {
    const s = makeSong();
    s.patterns[0]!.rows[2]![0]!.period = F0[12]!; // C-2 ch0
    s.patterns[0]!.rows[2]![1]!.period = F0[14]!; // D-2 ch1
    s.patterns[0]!.rows[3]![0]!.period = F0[16]!; // E-2 ch0
    s.patterns[0]!.rows[3]![2]!.period = F0[18]!; // F#-2 ch2 — outside range
    const range = { order: 0, startRow: 2, endRow: 3, startChannel: 0, endChannel: 1 };
    const next = transposeRange(s, range, 2); // up 2 semitones

    expect(next.patterns[0]!.rows[2]![0]!.period).toBe(F0[14]!);
    expect(next.patterns[0]!.rows[2]![1]!.period).toBe(F0[16]!);
    expect(next.patterns[0]!.rows[3]![0]!.period).toBe(F0[18]!);
    // ch2 was outside the rectangle — untouched.
    expect(next.patterns[0]!.rows[3]![2]!.period).toBe(F0[18]!);
  });

  it('preserves the sample / effect / effectParam fields on transposed cells', () => {
    const s = makeSong();
    const cell = s.patterns[0]!.rows[3]![1]!;
    cell.period = F0[12]!;
    cell.sample = 7;
    cell.effect = 0xa;
    cell.effectParam = 0x42;
    const next = transposeRange(s, rangeAt(0, 3, 1), 3);
    const after = next.patterns[0]!.rows[3]![1]!;
    expect(after.period).toBe(F0[15]!); // up 3 semitones
    expect(after.sample).toBe(7);
    expect(after.effect).toBe(0xa);
    expect(after.effectParam).toBe(0x42);
  });

  it('returns the same Song reference when nothing changed (delta=0 / all empty)', () => {
    const s = makeSong();
    expect(transposeRange(s, rangeAt(0, 3, 1), 0)).toBe(s);
  });
});
