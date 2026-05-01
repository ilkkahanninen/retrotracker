import { describe, expect, it } from 'vitest';
import {
  type Cursor,
  moveDown, moveLeft, moveRight, moveUp, pageDown, pageUp, tabNext, tabPrev,
} from '../src/state/cursor';
import { CHANNELS } from '../src/core/mod/types';
import { Effect, emptyPattern, emptySong } from '../src/core/mod/format';
import type { Song } from '../src/core/mod/types';

const C0: Cursor = { order: 0, row: 0, channel: 0, field: 'note' };

/** Build a song with N patterns (each empty) and orders [0,1,...,N-1]. */
function songWith(numPatterns: number): Song {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = numPatterns;
  for (let i = 0; i < numPatterns; i++) s.orders[i] = i;
  return s;
}

/** Set a Dxx (Pattern Break) on (orderIndex, row) jumping to nextRow on the next pattern. */
function setDxx(s: Song, orderIndex: number, row: number, nextRow: number): void {
  const patNum = s.orders[orderIndex]!;
  const cell = s.patterns[patNum]!.rows[row]![0]!;
  cell.effect = Effect.PatternBreak;
  cell.effectParam = ((Math.floor(nextRow / 10) & 0xf) << 4) | (nextRow % 10);
}

describe('cursor LEFT / RIGHT', () => {
  it('moves between fields within a channel', () => {
    let c = C0;
    c = moveRight(c); expect(c.field).toBe('sampleHi');
    c = moveRight(c); expect(c.field).toBe('sampleLo');
    c = moveRight(c); expect(c.field).toBe('effectCmd');
    c = moveRight(c); expect(c.field).toBe('effectHi');
    c = moveRight(c); expect(c.field).toBe('effectLo');
  });

  it('right at last field of last channel wraps to channel 0 note', () => {
    let c: Cursor = { order: 0, row: 0, channel: CHANNELS - 1, field: 'effectLo' };
    c = moveRight(c);
    expect(c.channel).toBe(0);
    expect(c.field).toBe('note');
  });

  it('left at note of channel 0 wraps to last channel effectLo', () => {
    let c = C0;
    c = moveLeft(c);
    expect(c.channel).toBe(CHANNELS - 1);
    expect(c.field).toBe('effectLo');
  });
});

describe('cursor TAB / SHIFT-TAB', () => {
  it('Tab advances to next channel and resets to note', () => {
    const c: Cursor = { order: 0, row: 5, channel: 0, field: 'effectHi' };
    const next = tabNext(c);
    expect(next).toEqual({ order: 0, row: 5, channel: 1, field: 'note' });
  });

  it('Tab wraps from last channel to first', () => {
    const c: Cursor = { order: 2, row: 7, channel: CHANNELS - 1, field: 'sampleHi' };
    expect(tabNext(c).channel).toBe(0);
    expect(tabNext(c).field).toBe('note');
  });

  it('Shift-Tab moves to previous channel and resets to note', () => {
    const c: Cursor = { order: 0, row: 0, channel: 2, field: 'sampleHi' };
    expect(tabPrev(c)).toEqual({ order: 0, row: 0, channel: 1, field: 'note' });
  });

  it('Shift-Tab wraps from first channel to last', () => {
    expect(tabPrev(C0).channel).toBe(CHANNELS - 1);
    expect(tabPrev(C0).field).toBe('note');
  });
});

describe('cursor UP / DOWN', () => {
  it('walks rows within a single pattern', () => {
    const s = songWith(1);
    expect(moveDown(C0, s).row).toBe(1);
    expect(moveDown({ ...C0, row: 5 }, s).row).toBe(6);
    expect(moveUp({ ...C0, row: 5 }, s).row).toBe(4);
  });

  it('clamps at the top edge of the song', () => {
    const s = songWith(1);
    expect(moveUp(C0, s)).toEqual(C0);
  });

  it('clamps at the bottom edge of the song', () => {
    const s = songWith(1);
    const last: Cursor = { ...C0, row: 63 };
    expect(moveDown(last, s)).toEqual(last);
  });

  it('crosses pattern boundaries', () => {
    const s = songWith(2);
    const lastOfFirst: Cursor = { ...C0, row: 63 };
    expect(moveDown(lastOfFirst, s)).toEqual({ ...C0, order: 1, row: 0 });
    expect(moveUp({ ...C0, order: 1, row: 0 }, s)).toEqual({ ...C0, order: 0, row: 63 });
  });

  it('skips Dxx-truncated rows', () => {
    const s = songWith(2);
    setDxx(s, 0, 10, 0); // Dxx at row 10 of pattern 0 → next pattern starts at row 0
    // moving down from row 10 should land on (order 1, row 0), not (order 0, row 11)
    const c: Cursor = { ...C0, row: 10 };
    expect(moveDown(c, s)).toEqual({ ...C0, order: 1, row: 0 });
  });
});

describe('cursor PAGE UP / DOWN', () => {
  it('jumps by N rows', () => {
    const s = songWith(1);
    const c: Cursor = { ...C0, row: 30 };
    expect(pageDown(c, s, 16).row).toBe(46);
    expect(pageUp(c, s, 16).row).toBe(14);
  });

  it('clamps at song bounds', () => {
    const s = songWith(1);
    const c: Cursor = { ...C0, row: 60 };
    // Bottom edge is row 63 (only pattern, full 64 rows).
    expect(pageDown(c, s, 16).row).toBe(63);
    expect(pageUp({ ...C0, row: 4 }, s, 16)).toEqual(C0);
  });
});
