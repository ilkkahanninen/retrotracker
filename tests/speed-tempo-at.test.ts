import { describe, expect, it } from "vitest";
import { speedTempoAt } from "../src/core/mod/flatten";
import { Effect, emptyPattern, emptySong } from "../src/core/mod/format";
import type { Song } from "../src/core/mod/types";

/** Build a song with N empty patterns, orders [0..N-1]. */
function songWith(numPatterns: number): Song {
  const s = emptySong();
  s.patterns = Array.from({ length: numPatterns }, emptyPattern);
  s.songLength = numPatterns;
  for (let i = 0; i < numPatterns; i++) s.orders[i] = i;
  return s;
}

function setFxx(
  s: Song,
  order: number,
  row: number,
  channel: number,
  param: number,
): void {
  const cell = s.patterns[s.orders[order]!]!.rows[row]![channel]!;
  cell.effect = Effect.SetSpeed;
  cell.effectParam = param;
}

describe("speedTempoAt", () => {
  it("returns MOD defaults if no Fxx anywhere before the position", () => {
    const s = songWith(2);
    expect(speedTempoAt(s, 1, 30)).toEqual({ speed: 6, tempo: 125 });
  });

  it("picks up a speed change from an earlier row", () => {
    const s = songWith(1);
    setFxx(s, 0, 5, 0, 0x03); // speed 3
    expect(speedTempoAt(s, 0, 30)).toEqual({ speed: 3, tempo: 125 });
  });

  it("picks up a tempo change from an earlier row", () => {
    const s = songWith(1);
    setFxx(s, 0, 8, 0, 0x7d); // tempo 125
    setFxx(s, 0, 9, 0, 0xa0); // tempo 160
    expect(speedTempoAt(s, 0, 30)).toEqual({ speed: 6, tempo: 0xa0 });
  });

  it("tracks speed and tempo independently", () => {
    const s = songWith(1);
    setFxx(s, 0, 2, 0, 0x04); // speed 4
    setFxx(s, 0, 3, 0, 0x80); // tempo 128
    expect(speedTempoAt(s, 0, 10)).toEqual({ speed: 4, tempo: 0x80 });
  });

  it("on a same row, last channel wins (matches replayer)", () => {
    const s = songWith(1);
    setFxx(s, 0, 5, 0, 0x03); // speed 3
    setFxx(s, 0, 5, 3, 0x05); // speed 5 — later channel wins
    expect(speedTempoAt(s, 0, 10).speed).toBe(5);
  });

  it("does NOT include the cursor row itself", () => {
    const s = songWith(1);
    setFxx(s, 0, 10, 0, 0x03); // speed 3 set ON the cursor row
    expect(speedTempoAt(s, 0, 10).speed).toBe(6); // not seen yet
    expect(speedTempoAt(s, 0, 11).speed).toBe(3); // seen by row 11
  });

  it("walks across patterns", () => {
    const s = songWith(3);
    setFxx(s, 0, 50, 0, 0x04);
    setFxx(s, 1, 5, 0, 0x70); // tempo 112
    expect(speedTempoAt(s, 2, 0)).toEqual({ speed: 4, tempo: 0x70 });
  });

  it("ignores F00 (stop song) for state tracking", () => {
    const s = songWith(1);
    setFxx(s, 0, 4, 0, 0x03); // speed 3
    setFxx(s, 0, 6, 0, 0x00); // F00 — should not reset
    expect(speedTempoAt(s, 0, 30).speed).toBe(3);
  });

  it("honors Dxx truncation when scanning", () => {
    // Pattern 0 has Dxx at row 5 jumping to row 0 of pattern 1, then a
    // speed change at row 30 of pattern 0. That speed change is past the
    // truncation and would never play, so it must NOT be picked up.
    const s = songWith(2);
    const r5 = s.patterns[0]!.rows[5]![0]!;
    r5.effect = Effect.PatternBreak;
    r5.effectParam = 0;
    setFxx(s, 0, 30, 0, 0x03); // hidden by Dxx
    expect(speedTempoAt(s, 1, 0).speed).toBe(6);
  });
});
