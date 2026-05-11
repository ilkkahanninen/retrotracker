/**
 * Format-agnostic Song union. Code that lives at the seam between the editor
 * UI / state and the format-specific cores imports from here. Code that has
 * already narrowed to one format imports `ModSong` or `XmSong` directly.
 */

import { CHANNELS, ROWS_PER_PATTERN, type ModSong } from "./mod/types";
import type { XmSong } from "./xm/types";

export type { ModSong } from "./mod/types";
export type { XmSong } from "./xm/types";

export type ProjectFormat = "PT2" | "FT2";

export type Song = ModSong | XmSong;

export function isPt2(song: Song): song is ModSong {
  return song.format === "PT2";
}

export function isFt2(song: Song): song is XmSong {
  return song.format === "FT2";
}

export function assertPt2(song: Song): asserts song is ModSong {
  if (song.format !== "PT2") {
    throw new Error(`Expected PT2 song, got ${song.format}`);
  }
}

export function assertFt2(song: Song): asserts song is XmSong {
  if (song.format !== "FT2") {
    throw new Error(`Expected FT2 song, got ${song.format}`);
  }
}

/** Active channel count for the current song. */
export function channelCount(song: Song): number {
  return song.format === "PT2" ? CHANNELS : song.channelCount;
}

/**
 * Row count for the pattern at the given pattern index. PT2 patterns are
 * always {@link ROWS_PER_PATTERN}; XM patterns vary per pattern.
 */
export function rowsOfPattern(song: Song, patternIndex: number): number {
  if (song.format === "PT2") return ROWS_PER_PATTERN;
  return song.patterns[patternIndex]?.rowCount ?? ROWS_PER_PATTERN;
}

/** Maximum addressable sample/instrument slots for the active song. */
export function sampleCapacity(song: Song): number {
  return song.format === "PT2" ? song.samples.length : 128;
}
