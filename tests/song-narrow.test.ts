import { describe, expect, it } from "vitest";

import { emptySong } from "~/core/mod/format";
import { emptyXmSong } from "~/core/xm/format";
import {
  assertFt2,
  assertPt2,
  channelCount,
  isFt2,
  isPt2,
  rowsOfPattern,
  sampleCapacity,
  type Song,
} from "~/core/song";
import { ROWS_PER_PATTERN } from "~/core/mod/types";

describe("Song union narrowing helpers", () => {
  it("isPt2 / isFt2 discriminate by the format field", () => {
    const pt: Song = emptySong();
    const xm: Song = emptyXmSong();
    expect(isPt2(pt)).toBe(true);
    expect(isFt2(pt)).toBe(false);
    expect(isPt2(xm)).toBe(false);
    expect(isFt2(xm)).toBe(true);
  });

  it("assertPt2 narrows successfully on PT2 songs", () => {
    const s: Song = emptySong();
    assertPt2(s);
    // After assert, samples is accessible — won't compile if narrow failed.
    expect(s.samples.length).toBe(31);
  });

  it("assertPt2 throws on FT2 songs", () => {
    const s: Song = emptyXmSong();
    expect(() => assertPt2(s)).toThrow(/PT2/);
  });

  it("assertFt2 narrows successfully on FT2 songs", () => {
    const s: Song = emptyXmSong();
    assertFt2(s);
    expect(s.channelCount).toBeGreaterThanOrEqual(2);
  });

  it("assertFt2 throws on PT2 songs", () => {
    const s: Song = emptySong();
    expect(() => assertFt2(s)).toThrow(/FT2/);
  });

  it("channelCount returns 4 for PT2 and the XM channelCount for FT2", () => {
    expect(channelCount(emptySong())).toBe(4);
    const xm = emptyXmSong();
    expect(channelCount(xm)).toBe(xm.channelCount);
  });

  it("rowsOfPattern returns 64 for PT2 and the XM pattern's rowCount for FT2", () => {
    const pt = emptySong();
    expect(rowsOfPattern(pt, 0)).toBe(ROWS_PER_PATTERN);
    const xm = emptyXmSong();
    expect(rowsOfPattern(xm, 0)).toBe(xm.patterns[0]!.rowCount);
  });

  it("sampleCapacity returns 31 for PT2 and 128 for FT2", () => {
    expect(sampleCapacity(emptySong())).toBe(31);
    expect(sampleCapacity(emptyXmSong())).toBe(128);
  });
});
