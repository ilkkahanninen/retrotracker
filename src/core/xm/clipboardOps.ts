/**
 * XM-flavoured `readXmSlice` / `clearXmRange` / `pasteXmSlice` — thin
 * wrappers around the shared `makeClipboardOps` factory in
 * `core/clipboardOps.ts`. The shared core handles iteration; the wrapper
 * supplies XM's variable pattern shape (per-pattern rowCount, per-song
 * channelCount).
 */

import { makeClipboardOps, type PatternRange } from "../clipboardOps";

import { emptyXmNote } from "./format";
import type { XmNote, XmPattern, XmSong } from "./types";

/** Re-exported for API stability; structurally identical to PT's `PatternRange`. */
export type XmPatternRange = PatternRange;

const ops = makeClipboardOps<XmNote, XmPattern, XmSong>({
  emptyNote: emptyXmNote,
  rowCountOf: (pat) => pat.rowCount,
  channelCountOf: (song) => song.channelCount,
  rebuildPattern: (old, rows) => ({ rows, rowCount: old.rowCount }),
});

/**
 * Read a slice of XM cells out of `song`. Returns `null` when the order
 * is unmapped, the pattern doesn't exist, or the range is empty.
 */
export function readXmSlice(
  song: XmSong,
  range: XmPatternRange,
): XmNote[][] | null {
  return ops.readSlice(song, range);
}

/**
 * Zero out every cell inside `range`. Returns a new XmSong; rows /
 * patterns outside the range share refs with the input.
 */
export function clearXmRange(song: XmSong, range: XmPatternRange): XmSong {
  return ops.clearRange(song, range);
}

/**
 * Stamp `slice` into the song starting at `(order, row, channel)`. Cells
 * past the pattern's variable rowCount or song.channelCount are silently
 * clipped — same friendly "paste at cursor" policy as PT.
 */
export function pasteXmSlice(
  song: XmSong,
  slice: XmNote[][],
  order: number,
  row: number,
  channel: number,
): XmSong {
  return ops.pasteSlice(song, slice, order, row, channel);
}
