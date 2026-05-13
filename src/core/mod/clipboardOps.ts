/**
 * PT-flavoured `readSlice` / `clearRange` / `pasteSlice` — thin wrappers
 * around the shared `makeClipboardOps` factory in `core/clipboardOps.ts`.
 * The shared core handles iteration; the wrapper supplies PT's fixed
 * pattern shape (`{ rows }`, 64 rows, 4 channels).
 */

import { makeClipboardOps, type PatternRange } from "../clipboardOps";
import { emptyNote } from "./format";
import type { ModSong, Note, Pattern } from "./types";
import { CHANNELS, ROWS_PER_PATTERN } from "./types";

export type { PatternRange };

const ops = makeClipboardOps<Note, Pattern, ModSong>({
  emptyNote,
  rowCountOf: () => ROWS_PER_PATTERN,
  channelCountOf: () => CHANNELS,
  rebuildPattern: (_old, rows) => ({ rows }),
});

/**
 * Read a slice of notes out of `song`. Returns `null` when the order is
 * unmapped, the pattern doesn't exist, or the range is empty. Cells in
 * the returned array are FRESH copies — callers can store them on the
 * clipboard without aliasing the song's note objects.
 */
export function readSlice(song: ModSong, range: PatternRange): Note[][] | null {
  return ops.readSlice(song, range);
}

/**
 * Zero out every cell inside `range`. Returns a new ModSong; rows /
 * patterns outside the range share refs with the input. No-op (returns
 * the same song reference) when the range doesn't resolve.
 */
export function clearRange(song: ModSong, range: PatternRange): ModSong {
  return ops.clearRange(song, range);
}

/**
 * Stamp `slice` into the song starting at `(order, row, channel)`. Anything
 * past pattern bounds (row >= 64, channel >= 4) is silently clipped —
 * friendliest behaviour for "paste at cursor".
 */
export function pasteSlice(
  song: ModSong,
  slice: Note[][],
  order: number,
  row: number,
  channel: number,
): ModSong {
  return ops.pasteSlice(song, slice, order, row, channel);
}
