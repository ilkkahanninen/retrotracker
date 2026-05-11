/**
 * Shared order-list CRUD shared by PT and XM mutation modules. The
 * factory takes a per-format `emptyPattern` / `clonePattern` and the
 * `maxOrders` cap, and returns the operations that are structurally
 * identical between the two formats.
 *
 * Not included here:
 *
 * - `setOrderPattern` — XM auto-grows the patterns array when the
 *   caller points at a slot past the current end; PT bails. Different
 *   semantics, kept per-format.
 * - `insertOrder` — PT's signature has no `patternNumber` (it duplicates
 *   the slot's current pattern); XM takes one. Different surfaces,
 *   kept per-format. PT can build its variant on `insertOrderAt`.
 * - `cleanupOrders` — only PT uses this today; if XM grows the same
 *   need, lift then.
 */

interface SongShape<TPattern> {
  songLength: number;
  orders: number[];
  patterns: TPattern[];
}

interface OrderOpsConfig<TPattern, TSong> {
  /** Build a fresh empty pattern. Takes the song so XM can size by
   *  `song.channelCount`. PT can ignore the argument. */
  emptyPattern: (song: TSong) => TPattern;
  clonePattern: (source: TPattern) => TPattern;
  maxOrders: number;
}

export interface OrderOps<TSong, TPattern> {
  /** Step the pattern number at `order` by +1, auto-growing the pattern
   *  bank if the new number is past the last existing pattern. */
  nextPatternAtOrder: (song: TSong, order: number) => TSong;
  /** Step the pattern number at `order` by -1, clamped at 0. */
  prevPatternAtOrder: (song: TSong, order: number) => TSong;
  /** Append a fresh empty pattern and point the slot at it. */
  newPatternAtOrder: (song: TSong, order: number) => TSong;
  /** Append a deep clone of the slot's current pattern and point at it. */
  duplicatePatternAtOrder: (song: TSong, order: number) => TSong;
  /** Insert a slot at `at`, pushing subsequent slots right. Uses
   *  `patternNumber` for the new slot. No-op past `maxOrders`. */
  insertOrderAt: (song: TSong, at: number, patternNumber: number) => TSong;
  /** Delete the slot at `at`, pulling subsequent slots left. The freed
   *  trailing slot is zeroed. Refuses to drop song length below 1. */
  deleteOrder: (song: TSong, at: number) => TSong;
}

export function makeOrderOps<TPattern, TSong extends SongShape<TPattern>>(
  cfg: OrderOpsConfig<TPattern, TSong>,
): OrderOps<TSong, TPattern> {
  const { emptyPattern, clonePattern, maxOrders } = cfg;

  function nextPatternAtOrder(song: TSong, order: number): TSong {
    if (order < 0 || order >= song.songLength) return song;
    const cur = song.orders[order] ?? 0;
    const next = cur + 1;
    if (next < song.patterns.length) {
      if (song.orders[order] === next) return song;
      const newOrders = [...song.orders];
      newOrders[order] = next;
      return { ...song, orders: newOrders };
    }
    // Auto-grow.
    const newPatterns: TPattern[] = [...song.patterns, emptyPattern(song)];
    const newOrders = [...song.orders];
    newOrders[order] = newPatterns.length - 1;
    return { ...song, patterns: newPatterns, orders: newOrders };
  }

  function prevPatternAtOrder(song: TSong, order: number): TSong {
    if (order < 0 || order >= song.songLength) return song;
    const cur = song.orders[order] ?? 0;
    if (cur <= 0) return song;
    const newOrders = [...song.orders];
    newOrders[order] = cur - 1;
    return { ...song, orders: newOrders };
  }

  function newPatternAtOrder(song: TSong, order: number): TSong {
    if (order < 0 || order >= song.songLength) return song;
    const newPatterns: TPattern[] = [...song.patterns, emptyPattern(song)];
    const newOrders = [...song.orders];
    newOrders[order] = newPatterns.length - 1;
    return { ...song, patterns: newPatterns, orders: newOrders };
  }

  function duplicatePatternAtOrder(song: TSong, order: number): TSong {
    if (order < 0 || order >= song.songLength) return song;
    const patNum = song.orders[order];
    if (patNum === undefined) return song;
    const source = song.patterns[patNum];
    if (!source) return song;
    const dup = clonePattern(source);
    const newPatterns: TPattern[] = [...song.patterns, dup];
    const newOrders = [...song.orders];
    newOrders[order] = newPatterns.length - 1;
    return { ...song, patterns: newPatterns, orders: newOrders };
  }

  function insertOrderAt(
    song: TSong,
    at: number,
    patternNumber: number,
  ): TSong {
    if (song.songLength >= maxOrders) return song;
    if (at < 0 || at > song.songLength) return song;
    const newOrders = [...song.orders];
    for (let i = song.songLength; i > at; i--) {
      newOrders[i] = newOrders[i - 1] ?? 0;
    }
    newOrders[at] = patternNumber;
    return { ...song, orders: newOrders, songLength: song.songLength + 1 };
  }

  function deleteOrder(song: TSong, at: number): TSong {
    if (song.songLength <= 1) return song;
    if (at < 0 || at >= song.songLength) return song;
    const newOrders = [...song.orders];
    for (let i = at; i < newOrders.length - 1; i++) {
      newOrders[i] = newOrders[i + 1] ?? 0;
    }
    newOrders[newOrders.length - 1] = 0;
    return { ...song, orders: newOrders, songLength: song.songLength - 1 };
  }

  return {
    nextPatternAtOrder,
    prevPatternAtOrder,
    newPatternAtOrder,
    duplicatePatternAtOrder,
    insertOrderAt,
    deleteOrder,
  };
}
