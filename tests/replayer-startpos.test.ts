import { describe, expect, it } from 'vitest';
import { Replayer } from '../src/core/audio/replayer';
import { emptyPattern, emptySong } from '../src/core/mod/format';
import type { Song } from '../src/core/mod/types';

const SR = 44100;

/** Build a song with N empty patterns, orders [0..N-1]. */
function songWith(numPatterns: number): Song {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = numPatterns;
  for (let i = 0; i < numPatterns; i++) s.orders[i] = i;
  return s;
}

/** Render `seconds` of audio through the replayer to walk it forward. */
function advance(r: Replayer, seconds: number): void {
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  r.process(left, right, frames);
}

describe('Replayer start-position options', () => {
  it('initialOrder/initialRow place the playhead at construction', () => {
    const song = songWith(3);
    const r = new Replayer(song, { sampleRate: SR, initialOrder: 2, initialRow: 17 });
    expect(r.getOrderIndex()).toBe(2);
    expect(r.getRow()).toBe(17);
  });

  it('clamps an out-of-range initialOrder', () => {
    const song = songWith(2);
    const r = new Replayer(song, { sampleRate: SR, initialOrder: 99, initialRow: 0 });
    expect(r.getOrderIndex()).toBe(1); // last valid
  });

  it('clamps an out-of-range initialRow', () => {
    const song = songWith(1);
    const r = new Replayer(song, { sampleRate: SR, initialOrder: 0, initialRow: 999 });
    expect(r.getRow()).toBe(63);
  });
});

describe('Replayer loopPattern', () => {
  // One empty pattern at 125 BPM × speed 6 = ~7.7s. Advance ~8.5s so we'd be
  // somewhere into the *next* pattern under normal advancement.
  const PAST_ONE_PATTERN_SEC = 8.5;

  it('keeps playback locked to the starting order', () => {
    const song = songWith(3);
    const r = new Replayer(song, {
      sampleRate: SR,
      loop: true,
      loopPattern: true,
      initialOrder: 1,
      initialRow: 0,
    });
    advance(r, PAST_ONE_PATTERN_SEC);
    expect(r.getOrderIndex()).toBe(1);
  });

  it('without loopPattern, advances to the next order after one pattern', () => {
    const song = songWith(3);
    const r = new Replayer(song, {
      sampleRate: SR,
      loop: true,
      initialOrder: 1,
      initialRow: 0,
    });
    advance(r, PAST_ONE_PATTERN_SEC);
    expect(r.getOrderIndex()).toBe(2);
  });
});
