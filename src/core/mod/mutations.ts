import type { Note, Pattern, Sample, Song } from './types';
import { MAX_ORDERS } from './types';
import { emptyNote, emptyPattern, emptySample, PERIOD_TABLE } from './format';

/**
 * Return a new Song with one cell's fields overridden, sharing every other
 * pattern/row/cell by reference. Suitable for `commitEdit`'s undo snapshots.
 *
 * No-ops (returns the same Song reference) when the addressed cell is out
 * of range, when the order is unmapped, or when the patch wouldn't change
 * any of the existing fields.
 */
export function setCell(
  song: Song,
  order: number,
  row: number,
  channel: number,
  patch: Partial<Note>,
): Song {
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const pattern = song.patterns[patNum];
  if (!pattern) return song;
  const oldRow = pattern.rows[row];
  if (!oldRow) return song;
  const oldCell = oldRow[channel];
  if (!oldCell) return song;

  // Reference-equal short-circuit: skip building new arrays if nothing changed.
  let changed = false;
  for (const k of Object.keys(patch) as (keyof Note)[]) {
    if (oldCell[k] !== patch[k]) { changed = true; break; }
  }
  if (!changed) return song;

  const newCell: Note = { ...oldCell, ...patch };
  const newRow: Note[] = [...oldRow];
  newRow[channel] = newCell;
  const newRows: Note[][] = [...pattern.rows];
  newRows[row] = newRow;
  const newPattern: Pattern = { rows: newRows };
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Resolve `(order)` to a concrete pattern + index, or null if the order is
 * out of range or unmapped. Shared by the row-shifting mutations below.
 */
function resolvePattern(song: Song, order: number): { pattern: Pattern; patNum: number } | null {
  if (order < 0 || order >= song.songLength) return null;
  const patNum = song.orders[order];
  if (patNum === undefined) return null;
  const pattern = song.patterns[patNum];
  if (!pattern) return null;
  return { pattern, patNum };
}

/**
 * Build a new Song where the cells on `channel` from `fromRow` onward are
 * replaced with `nextCells[i]`, leaving every other row/channel/pattern
 * shared by reference. `nextCells` must have exactly `pattern.rows.length -
 * fromRow` entries.
 *
 * Returns the input Song reference unchanged when no replacement actually
 * differs from the existing cell — same short-circuit shape as `setCell`.
 */
function replaceChannelTail(
  song: Song,
  patNum: number,
  pattern: Pattern,
  channel: number,
  fromRow: number,
  nextCells: Note[],
): Song {
  let changed = false;
  for (let i = 0; i < nextCells.length; i++) {
    if (pattern.rows[fromRow + i]![channel] !== nextCells[i]) { changed = true; break; }
  }
  if (!changed) return song;

  const newRows: Note[][] = [...pattern.rows];
  for (let i = 0; i < nextCells.length; i++) {
    const r = fromRow + i;
    const oldRow = pattern.rows[r]!;
    const newRow: Note[] = [...oldRow];
    newRow[channel] = nextCells[i]!;
    newRows[r] = newRow;
  }
  const newPattern: Pattern = { rows: newRows };
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Delete the cell at (order, row, channel) and pull every cell below it on
 * the same channel up by one row. The pattern's last row on this channel
 * becomes an empty note. Other channels are untouched.
 *
 * No-op when the address is out of range.
 */
export function deleteCellPullUp(song: Song, order: number, row: number, channel: number): Song {
  const ctx = resolvePattern(song, order);
  if (!ctx) return song;
  const { pattern, patNum } = ctx;
  if (row < 0 || row >= pattern.rows.length) return song;
  if (channel < 0 || channel >= (pattern.rows[0]?.length ?? 0)) return song;

  const tail: Note[] = [];
  for (let r = row + 1; r < pattern.rows.length; r++) tail.push(pattern.rows[r]![channel]!);
  tail.push(emptyNote());
  return replaceChannelTail(song, patNum, pattern, channel, row, tail);
}

/**
 * Insert an empty cell at (order, row, channel), shifting every cell at or
 * below this row on the same channel down by one. The cell that was on the
 * last row of this channel falls off the end. Other channels are untouched.
 *
 * No-op when the address is out of range.
 */
export function insertCellPushDown(song: Song, order: number, row: number, channel: number): Song {
  const ctx = resolvePattern(song, order);
  if (!ctx) return song;
  const { pattern, patNum } = ctx;
  if (row < 0 || row >= pattern.rows.length) return song;
  if (channel < 0 || channel >= (pattern.rows[0]?.length ?? 0)) return song;

  const tail: Note[] = [emptyNote()];
  for (let r = row; r < pattern.rows.length - 1; r++) tail.push(pattern.rows[r]![channel]!);
  return replaceChannelTail(song, patNum, pattern, channel, row, tail);
}

// ─── Order list ───────────────────────────────────────────────────────────

/**
 * Replace the pattern number at `song.orders[order]`. No-op if the order is
 * out of range, the target pattern doesn't exist, or the slot already points
 * at it.
 */
export function setOrderPattern(song: Song, order: number, patNum: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  if (patNum < 0 || patNum >= song.patterns.length) return song;
  if (song.orders[order] === patNum) return song;
  const newOrders = [...song.orders];
  newOrders[order] = patNum;
  return { ...song, orders: newOrders };
}

/**
 * Step the pattern number at `order` by +1. If the new number would go past
 * the last existing pattern, append a fresh empty pattern and point the slot
 * at it (FT2-style auto-grow). No-op when the order is out of range.
 */
export function nextPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const next = cur + 1;
  if (next < song.patterns.length) return setOrderPattern(song, order, next);
  // Auto-grow: append a new empty pattern and point the slot at it.
  const newPatterns: Pattern[] = [...song.patterns, emptyPattern()];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/**
 * Step the pattern number at `order` by -1, clamped at 0. No-op when the
 * order is out of range or the slot is already at pattern 0.
 */
export function prevPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  if (cur <= 0) return song;
  return setOrderPattern(song, order, cur - 1);
}

/**
 * Insert a new order slot at index `order`, shifting subsequent slots right
 * by one. The inserted slot duplicates the current slot's pattern number, so
 * the user sees the same pattern at the new position and can step from there.
 *
 * No-op if the song is already at MAX_ORDERS (128) or `order` is out of range.
 */
export function insertOrder(song: Song, order: number): Song {
  if (song.songLength >= MAX_ORDERS) return song;
  if (order < 0 || order > song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const newOrders = [...song.orders];
  for (let i = newOrders.length - 1; i > order; i--) {
    newOrders[i] = newOrders[i - 1] ?? 0;
  }
  newOrders[order] = cur;
  return { ...song, orders: newOrders, songLength: song.songLength + 1 };
}

/**
 * Delete the order slot at `order`, pulling subsequent slots left. The last
 * (now unused) slot resets to 0. No-op when the song is already at length 1
 * — we keep at least one playable order — or `order` is out of range.
 *
 * Note: this only edits the orders array. Patterns the deleted slot pointed
 * to remain in `song.patterns`, since other slots may still reference them.
 */
export function deleteOrder(song: Song, order: number): Song {
  if (song.songLength <= 1) return song;
  if (order < 0 || order >= song.songLength) return song;
  const newOrders = [...song.orders];
  for (let i = order; i < newOrders.length - 1; i++) {
    newOrders[i] = newOrders[i + 1] ?? 0;
  }
  newOrders[newOrders.length - 1] = 0;
  return { ...song, orders: newOrders, songLength: song.songLength - 1 };
}

/**
 * Append a fresh empty pattern and point `song.orders[order]` at it. Lets the
 * user blank out a slot without having to step through pattern numbers, and
 * leaves the previously-pointed-at pattern intact (other slots may still
 * reference it). No-op when `order` is out of range.
 */
export function newPatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const newPatterns: Pattern[] = [...song.patterns, emptyPattern()];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/**
 * Append a copy of the pattern under `order` and point the slot at the copy.
 * The previously-pointed-at pattern stays intact (other slots may share it).
 *
 * The copy clones the rows array and each row, but shares Note references —
 * Notes are treated as immutable elsewhere, and `setCell` rewrites the row
 * arrays it touches, so future edits to the copy can't bleed into the source.
 *
 * No-op when `order` is out of range or the slot points at a missing pattern.
 */
export function duplicatePatternAtOrder(song: Song, order: number): Song {
  if (order < 0 || order >= song.songLength) return song;
  const patNum = song.orders[order];
  if (patNum === undefined) return song;
  const source = song.patterns[patNum];
  if (!source) return song;
  const dup: Pattern = { rows: source.rows.map((row) => [...row]) };
  const newPatterns: Pattern[] = [...song.patterns, dup];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

// ─── Samples ──────────────────────────────────────────────────────────────

/**
 * Replace fields on `song.samples[slot]`. Patches the named keys, leaves the
 * rest alone. Returns the same Song reference when nothing actually changed.
 *
 * The stored sample.data is the full post-pipeline int8 — we never drop
 * bytes here, even when the loop ends before sampleEnd. The trailing
 * portion stays available for the waveform UI to show and for the user to
 * reach by extending the loop end. The PT loopStart=0 quirk is sidestepped
 * at the playback boundary instead (see core/audio/loopTruncate.ts), so
 * loop editing stays non-destructive: drag the loop end inward, drag it
 * back out, the data is still there.
 */
export function setSample(song: Song, slot: number, patch: Partial<Sample>): Song {
  if (slot < 0 || slot >= song.samples.length) return song;
  const old = song.samples[slot];
  if (!old) return song;
  let changed = false;
  for (const k of Object.keys(patch) as (keyof Sample)[]) {
    if (old[k] !== patch[k]) { changed = true; break; }
  }
  if (!changed) return song;
  const newSample: Sample = { ...old, ...patch };
  const newSamples: Sample[] = [...song.samples];
  newSamples[slot] = newSample;
  return { ...song, samples: newSamples };
}

/** Reset `song.samples[slot]` to the empty/default sample. No-op if out of range. */
export function clearSample(song: Song, slot: number): Song {
  if (slot < 0 || slot >= song.samples.length) return song;
  const old = song.samples[slot];
  if (!old) return song;
  if (old.lengthWords === 0 && old.name === '' && old.volume === 0) return song;
  const newSamples: Sample[] = [...song.samples];
  newSamples[slot] = emptySample();
  return { ...song, samples: newSamples };
}

/**
 * Replace the PCM payload of `song.samples[slot]` with new audio data, plus
 * optional name/volume/finetune overrides for what gets associated with it.
 *
 * Sample data is word-aligned in PT, so an odd-length input is padded with a
 * trailing zero byte. `lengthWords` is recomputed from the padded data, and
 * loop points are reset to "no loop" — the user can dial them in afterward.
 *
 * Inputs longer than PT's 16-bit `lengthWords` field (max 65535 words ≈ 128 KB)
 * are truncated to fit.
 */
export function replaceSampleData(
  song: Song,
  slot: number,
  data: Int8Array,
  meta: Partial<Pick<Sample, 'name' | 'volume' | 'finetune' | 'loopStartWords' | 'loopLengthWords'>> = {},
): Song {
  if (slot < 0 || slot >= song.samples.length) return song;

  // Word-align: pad odd-length inputs by one zero byte so lengthWords is exact.
  const aligned = data.byteLength % 2 === 0
    ? data
    : ((): Int8Array => {
        const p = new Int8Array(data.byteLength + 1);
        p.set(data);
        return p;
      })();
  // Cap at PT's 16-bit lengthWords field.
  const MAX_BYTES = 65535 * 2;
  const capped = aligned.byteLength > MAX_BYTES
    ? aligned.subarray(0, MAX_BYTES)
    : aligned;
  const lengthWords = capped.byteLength >> 1;

  // Preserve any loop the caller supplied, but clamp it to the new length so
  // an effect that shortens the sample (e.g. crop) can't leave the loop
  // pointing past the data. When no loop is passed, default to PT's no-loop
  // sentinel (0, 1) — matches replaceSampleData's pre-loop-passing behaviour.
  const loopStartReq = meta.loopStartWords ?? 0;
  const loopStart = Math.max(0, Math.min(loopStartReq, Math.max(0, lengthWords - 1)));
  const loopLenReq = meta.loopLengthWords ?? 1;
  const loopMax = Math.max(1, lengthWords - loopStart);
  const loopLen = Math.max(1, Math.min(loopLenReq, loopMax));

  return setSample(song, slot, {
    ...meta,
    data: capped,
    lengthWords,
    loopStartWords: loopStart,
    loopLengthWords: loopLen,
  });
}

/**
 * Shift a stored Paula period by `deltaSemitones`, snapping to PT's
 * 36-slot finetune-0 grid. Returns null when:
 *   - the period is 0 (empty cell — caller should leave the cell alone)
 *   - the period is too far off the table to be located (PT-clamped 113..856
 *     covers everything we ship, but a malformed mod could carry oddballs)
 *
 * We always read & write through finetune row 0. Finetune information is
 * carried by the sample, not the period — re-quantising into the
 * canonical row preserves the user's "transpose by N semitones" mental
 * model and avoids needing to scan back for the active sample on the
 * channel just to keep an exotic finetune intact across a transpose.
 */
function transposePeriod(period: number, deltaSemitones: number): number | null {
  if (period === 0) return null;
  const row = PERIOD_TABLE[0]!;
  // PT's `setPeriod` algorithm: first slot whose period is <= the stored
  // value (table is descending — slot 0 = C-1 = 856, slot 35 = B-3 = 113).
  let slot = -1;
  for (let i = 0; i < row.length; i++) {
    if (period >= row[i]!) { slot = i; break; }
  }
  if (slot < 0) return null;
  // Clamp at the edges instead of refusing the whole transpose. A user
  // shifting a phrase up that contains one already-top-note still
  // transposes the rest; the boundary cell stays put. Mirrors how every
  // mainstream tracker handles transpose-out-of-range.
  const target = Math.max(0, Math.min(row.length - 1, slot + deltaSemitones));
  return row[target]!;
}

/**
 * Transpose every non-empty note inside a rectangular range by the given
 * number of semitones. Empty cells (period = 0) are skipped — transpose
 * never introduces a note where there wasn't one. Range is given in
 * pattern-relative coordinates (resolved through `song.orders[order]`).
 *
 * Returns the same Song reference when nothing changed (the range was
 * empty, all cells were already at the clamp edge, etc.) so commitEdit's
 * "no-op" guard skips a redundant history entry.
 */
export function transposeRange(
  song: Song,
  range: {
    order: number;
    startRow: number; endRow: number;
    startChannel: number; endChannel: number;
  },
  deltaSemitones: number,
): Song {
  if (deltaSemitones === 0) return song;
  if (range.order < 0 || range.order >= song.songLength) return song;
  const patNum = song.orders[range.order];
  if (patNum === undefined) return song;
  const pattern = song.patterns[patNum];
  if (!pattern) return song;

  let patternChanged = false;
  const newRows: Note[][] = pattern.rows.map((row, rowIdx) => {
    if (rowIdx < range.startRow || rowIdx > range.endRow) return row;
    let rowChanged = false;
    const newRow: Note[] = row.map((cell, chIdx) => {
      if (chIdx < range.startChannel || chIdx > range.endChannel) return cell;
      const newPeriod = transposePeriod(cell.period, deltaSemitones);
      if (newPeriod === null || newPeriod === cell.period) return cell;
      rowChanged = true;
      return { ...cell, period: newPeriod };
    });
    if (!rowChanged) return row;
    patternChanged = true;
    return newRow;
  });

  if (!patternChanged) return song;
  const newPatterns: Pattern[] = [...song.patterns];
  newPatterns[patNum] = { rows: newRows };
  return { ...song, patterns: newPatterns };
}
