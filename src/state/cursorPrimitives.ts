import type { FlatRowRef } from "../core/flatten";

export function moveAlongFields<F extends readonly string[]>(
  fields: F,
  current: F[number],
  dir: -1 | 1,
  channelCount: number,
  channel: number,
): { field: F[number]; channel: number } {
  const idx = fields.indexOf(current);
  if (dir < 0) {
    if (idx > 0) return { field: fields[idx - 1]!, channel };
    return {
      field: fields[fields.length - 1]!,
      channel: (channel - 1 + channelCount) % channelCount,
    };
  }
  if (idx < fields.length - 1) return { field: fields[idx + 1]!, channel };
  return { field: fields[0]!, channel: (channel + 1) % channelCount };
}

export function cycleChannel(
  channel: number,
  dir: -1 | 1,
  channelCount: number,
): number {
  return dir > 0
    ? (channel + 1) % channelCount
    : (channel - 1 + channelCount) % channelCount;
}

/**
 * Move a cursor `delta` rows through a flat (visible-row) list — the
 * rows the pattern grid actually shows, so the cursor skips rows hidden
 * by a Dxx pattern break and crosses order boundaries the way the grid
 * scrolls. Clamps at both ends of the song.
 *
 * A cursor sitting on a hidden row (an edit can hide the row it is on)
 * is first snapped to the last visible row at or before it.
 */
export function moveByFlatRows<C extends { order: number; row: number }>(
  c: C,
  flat: readonly FlatRowRef[],
  delta: number,
): C {
  if (flat.length === 0) return c;
  let idx = -1;
  for (let i = 0; i < flat.length; i++) {
    const fr = flat[i]!;
    if (fr.order === c.order && fr.rowIndex === c.row) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    idx = 0;
    for (let i = flat.length - 1; i >= 0; i--) {
      const fr = flat[i]!;
      if (
        fr.order < c.order ||
        (fr.order === c.order && fr.rowIndex <= c.row)
      ) {
        idx = i;
        break;
      }
    }
  }
  const target = flat[Math.max(0, Math.min(flat.length - 1, idx + delta))]!;
  return { ...c, order: target.order, row: target.rowIndex };
}
