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
  /**
   * Repeat a run of slots: insert a copy of `orders[start..end]`
   * (inclusive) right after it, with the same pattern numbers, pushing
   * the rest of the song right.
   *
   *   orders [0,1,2,3], range 1..2 → [0,1,2,1,2,3]
   *
   * All or nothing: when the copy would not fit under `maxOrders` the
   * song is returned unchanged rather than repeating part of the run.
   */
  repeatOrderRange: (song: TSong, start: number, end: number) => TSong;
  /**
   * Give the slots `start..end` (inclusive) their own copies of the
   * patterns they play, so the run can be edited without touching the
   * rest of the song. Each distinct pattern is cloned once and slots
   * that shared a pattern share the clone — the run keeps its shape.
   *
   *   orders [0,1,2,1,2,3] over 4 patterns, range 3..4 → [0,1,2,4,5,3]
   */
  duplicatePatternsInRange: (song: TSong, start: number, end: number) => TSong;
  /** Delete the slots `start..end` (inclusive), pulling the rest left and
   *  zeroing the freed tail. Always leaves at least one slot: a range
   *  covering the whole song keeps its first slot. */
  deleteOrderRange: (song: TSong, start: number, end: number) => TSong;
  /**
   * Tidy the order list and pattern bank: renumber patterns in order of
   * first appearance in the order list and drop the ones no slot
   * references.
   *
   *   orders [4,5,0,0,1] over patterns [p0..p5]
   *        → [0,1,2,2,3] over patterns [p4,p5,p0,p1]
   *
   * `remap[oldIndex]` is the pattern's new index, or `undefined` if it was
   * dropped — side-tables keyed by pattern index re-key through it. Slots
   * beyond `songLength` are zeroed so nothing written to disk points past
   * the trimmed bank. Returns the same song reference when already tidy.
   */
  cleanupOrders: (song: TSong) => {
    song: TSong;
    remap: (number | undefined)[];
  };
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

  /** Clamp an inclusive slot range into the song; null when empty. */
  function clampRange(
    song: TSong,
    start: number,
    end: number,
  ): { start: number; end: number } | null {
    const lo = Math.max(0, Math.min(start, end));
    const hi = Math.min(song.songLength - 1, Math.max(start, end));
    return hi < lo ? null : { start: lo, end: hi };
  }

  function repeatOrderRange(song: TSong, start: number, end: number): TSong {
    const range = clampRange(song, start, end);
    if (!range) return song;
    const count = range.end - range.start + 1;
    if (song.songLength + count > maxOrders) return song;
    const live = song.orders.slice(0, song.songLength);
    const block = live.slice(range.start, range.end + 1);
    const next = [
      ...live.slice(0, range.end + 1),
      ...block,
      ...live.slice(range.end + 1),
    ];
    const newOrders = [...song.orders];
    for (let i = 0; i < next.length; i++) newOrders[i] = next[i]!;
    return { ...song, orders: newOrders, songLength: next.length };
  }

  function duplicatePatternsInRange(
    song: TSong,
    start: number,
    end: number,
  ): TSong {
    const range = clampRange(song, start, end);
    if (!range) return song;
    const newPatterns: TPattern[] = [...song.patterns];
    const newOrders = [...song.orders];
    const cloneOf = new Map<number, number>();
    for (let i = range.start; i <= range.end; i++) {
      const patNum = song.orders[i];
      if (patNum === undefined) continue;
      let clone = cloneOf.get(patNum);
      if (clone === undefined) {
        const source = song.patterns[patNum];
        // A slot pointing past the pattern bank has nothing to copy.
        if (!source) continue;
        clone = newPatterns.length;
        newPatterns.push(clonePattern(source));
        cloneOf.set(patNum, clone);
      }
      newOrders[i] = clone;
    }
    if (cloneOf.size === 0) return song;
    return { ...song, patterns: newPatterns, orders: newOrders };
  }

  function deleteOrderRange(song: TSong, start: number, end: number): TSong {
    const range = clampRange(song, start, end);
    if (!range) return song;
    const live = song.orders.slice(0, song.songLength);
    // Keep at least one playable slot: a range over the whole song
    // spares its first slot.
    const from =
      range.start === 0 && range.end === song.songLength - 1 ? 1 : range.start;
    if (from > range.end) return song;
    const next = [...live.slice(0, from), ...live.slice(range.end + 1)];
    // Everything past the new end is zeroed, like the single-slot delete.
    const newOrders = new Array<number>(song.orders.length).fill(0);
    for (let i = 0; i < next.length; i++) newOrders[i] = next[i]!;
    return { ...song, orders: newOrders, songLength: next.length };
  }

  function cleanupOrders(song: TSong): {
    song: TSong;
    remap: (number | undefined)[];
  } {
    const remap: (number | undefined)[] = new Array(song.patterns.length).fill(
      undefined,
    );
    const newPatterns: TPattern[] = [];
    for (let i = 0; i < song.songLength; i++) {
      const pat = song.orders[i] ?? 0;
      if (pat < 0 || pat >= song.patterns.length) continue;
      if (remap[pat] === undefined) {
        remap[pat] = newPatterns.length;
        newPatterns.push(song.patterns[pat]!);
      }
    }

    const newOrders = new Array<number>(song.orders.length).fill(0);
    for (let i = 0; i < song.songLength; i++) {
      const pat = song.orders[i] ?? 0;
      newOrders[i] = remap[pat] ?? 0;
    }

    let changed = newPatterns.length !== song.patterns.length;
    if (!changed) {
      for (let i = 0; i < song.orders.length; i++) {
        if (newOrders[i] !== (song.orders[i] ?? 0)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return { song, remap };

    return {
      song: { ...song, orders: newOrders, patterns: newPatterns },
      remap,
    };
  }

  return {
    cleanupOrders,
    nextPatternAtOrder,
    prevPatternAtOrder,
    newPatternAtOrder,
    duplicatePatternAtOrder,
    insertOrderAt,
    deleteOrder,
    repeatOrderRange,
    duplicatePatternsInRange,
    deleteOrderRange,
  };
}
