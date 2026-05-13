/**
 * Immutable mutations for `XmSong`. Mirrors the shape of
 * `core/mod/mutations.ts` so the editor state machinery (history,
 * commit, etc.) reads the same way regardless of format.
 *
 * Phase 3-2: covers cell editing, transposition, channel-count change,
 * pattern-row-count change, order-list ops, and minimal sample
 * mutations. The instrument editor (envelopes, autovibrato, fadeout)
 * arrives in Phase 4.
 */

import { makeOrderOps } from "../orderOps";
import {
  defaultXmEnvelope,
  emptyXmInstrument,
  emptyXmNote,
  emptyXmPattern,
  emptyXmSample,
} from "./format";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_KEYOFF_NOTE,
  XM_MAX_CHANNELS,
  XM_MAX_ENVELOPE_POINTS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_ORDERS,
  XM_MAX_PATTERN_ROWS,
  XM_MIN_PATTERN_ROWS,
  type XmEnvelope,
  type XmEnvelopePoint,
  type XmInstrument,
  type XmNote,
  type XmPattern,
  type XmSample,
  type XmSong,
} from "./types";

/**
 * Order-list CRUD factory — same shape as the PT side. XM creates new
 * patterns sized to the song's current `channelCount` (read at call
 * time via the `emptyPattern(song)` hook), and deep-clones cells when
 * duplicating because XmNote objects are sometimes mutated locally
 * before commit.
 */
const orderOps = makeOrderOps<XmPattern, XmSong>({
  emptyPattern: (song) => emptyXmPattern(64, song.channelCount),
  clonePattern: (src) => ({
    rows: src.rows.map((row) => row.map((cell) => ({ ...cell }))),
    rowCount: src.rowCount,
  }),
  maxOrders: XM_MAX_ORDERS,
});

/**
 * Replace the cell at (order, row, channel) with the patch's fields.
 * Returns the same song reference if nothing actually changed (lets
 * commit machinery skip the history push).
 */
export function setXmCell(
  song: XmSong,
  order: number,
  row: number,
  channel: number,
  patch: Partial<XmNote>,
): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const patternIndex = song.orders[order];
  if (patternIndex === undefined) return song;
  const pattern = song.patterns[patternIndex];
  if (!pattern) return song;
  if (row < 0 || row >= pattern.rowCount) return song;
  if (channel < 0 || channel >= song.channelCount) return song;
  const oldRow = pattern.rows[row]!;
  const oldCell = oldRow[channel]!;
  const merged: XmNote = { ...oldCell, ...patch };
  if (
    merged.note === oldCell.note &&
    merged.instrument === oldCell.instrument &&
    merged.volumeColumn === oldCell.volumeColumn &&
    merged.effect === oldCell.effect &&
    merged.effectParam === oldCell.effectParam
  ) {
    return song;
  }
  const newRow: XmNote[] = [...oldRow];
  newRow[channel] = merged;
  const newRows: XmNote[][] = [...pattern.rows];
  newRows[row] = newRow;
  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patternIndex] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Delete the cell at (order, row, channel) and pull every cell below
 * it on the same channel up by one row. The pattern's last row on this
 * channel becomes an empty note. Other channels are untouched.
 *
 * No-op when the address is out of range.
 */
export function deleteXmCellPullUp(
  song: XmSong,
  order: number,
  row: number,
  channel: number,
): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const patIdx = song.orders[order];
  if (patIdx === undefined) return song;
  const pattern = song.patterns[patIdx];
  if (!pattern) return song;
  if (row < 0 || row >= pattern.rowCount) return song;
  if (channel < 0 || channel >= song.channelCount) return song;

  const newRows: XmNote[][] = pattern.rows.map((r, idx) => {
    if (idx < row) return r;
    const newRow: XmNote[] = [...r];
    if (idx === pattern.rowCount - 1) {
      newRow[channel] = emptyXmNote();
    } else {
      newRow[channel] = pattern.rows[idx + 1]![channel]!;
    }
    return newRow;
  });
  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patIdx] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Delete the row at (order, row) — every channel — and pull every row
 * below it up by one. The pattern's last row becomes empty across all
 * channels.
 *
 * No-op when the address is out of range.
 */
export function deleteXmRowPullUp(
  song: XmSong,
  order: number,
  row: number,
): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const patIdx = song.orders[order];
  if (patIdx === undefined) return song;
  const pattern = song.patterns[patIdx];
  if (!pattern) return song;
  if (row < 0 || row >= pattern.rowCount) return song;

  const newRows: XmNote[][] = [...pattern.rows];
  for (let r = row; r < pattern.rowCount - 1; r++) {
    newRows[r] = pattern.rows[r + 1]!;
  }
  const lastRow: XmNote[] = new Array(song.channelCount);
  for (let c = 0; c < song.channelCount; c++) lastRow[c] = emptyXmNote();
  newRows[pattern.rowCount - 1] = lastRow;

  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patIdx] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Insert an empty row at (order, row) — every channel — shifting every
 * row at or below this row down by one. The row that was on the last
 * position of the pattern falls off the end.
 *
 * No-op when the address is out of range.
 */
export function insertXmRowPushDown(
  song: XmSong,
  order: number,
  row: number,
): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const patIdx = song.orders[order];
  if (patIdx === undefined) return song;
  const pattern = song.patterns[patIdx];
  if (!pattern) return song;
  if (row < 0 || row >= pattern.rowCount) return song;

  const newRows: XmNote[][] = [...pattern.rows];
  for (let r = pattern.rowCount - 1; r > row; r--) {
    newRows[r] = pattern.rows[r - 1]!;
  }
  const blank: XmNote[] = new Array(song.channelCount);
  for (let c = 0; c < song.channelCount; c++) blank[c] = emptyXmNote();
  newRows[row] = blank;

  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patIdx] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Insert an empty cell at (order, row, channel), shifting every cell at
 * or below this row on the same channel down by one. The cell that was
 * on the last row of this channel falls off the end. Other channels are
 * untouched.
 *
 * No-op when the address is out of range.
 */
export function insertXmCellPushDown(
  song: XmSong,
  order: number,
  row: number,
  channel: number,
): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const patIdx = song.orders[order];
  if (patIdx === undefined) return song;
  const pattern = song.patterns[patIdx];
  if (!pattern) return song;
  if (row < 0 || row >= pattern.rowCount) return song;
  if (channel < 0 || channel >= song.channelCount) return song;

  const newRows: XmNote[][] = pattern.rows.map((r, idx) => {
    if (idx < row) return r;
    const newRow: XmNote[] = [...r];
    if (idx === row) {
      newRow[channel] = emptyXmNote();
    } else {
      newRow[channel] = pattern.rows[idx - 1]![channel]!;
    }
    return newRow;
  });
  const newPattern: XmPattern = { rows: newRows, rowCount: pattern.rowCount };
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patIdx] = newPattern;
  return { ...song, patterns: newPatterns };
}

/**
 * Transpose every non-empty melodic note inside a rectangular range by
 * the given number of semitones. Empty cells (note = 0) and key-off
 * (note = 97) are skipped — transpose never introduces a note where
 * there wasn't one, and key-off has no pitch to shift. Notes that would
 * fall outside the 1..96 range clamp at the bound, matching how PT2's
 * `transposeRange` clamps at the period table edges.
 *
 * Returns the same XmSong reference when nothing changed (the range was
 * empty, all cells were already at the clamp edge, etc.) so commitEditXm's
 * "no-op" guard skips a redundant history entry.
 */
export function transposeRangeXm(
  song: XmSong,
  range: {
    order: number;
    startRow: number;
    endRow: number;
    startChannel: number;
    endChannel: number;
  },
  deltaSemitones: number,
): XmSong {
  if (deltaSemitones === 0) return song;
  if (range.order < 0 || range.order >= song.songLength) return song;
  const patIdx = song.orders[range.order];
  if (patIdx === undefined) return song;
  const pattern = song.patterns[patIdx];
  if (!pattern) return song;

  let patternChanged = false;
  const newRows: XmNote[][] = pattern.rows.map((row, rowIdx) => {
    if (rowIdx < range.startRow || rowIdx > range.endRow) return row;
    let rowChanged = false;
    const newRow: XmNote[] = row.map((cell, chIdx) => {
      if (chIdx < range.startChannel || chIdx > range.endChannel) return cell;
      if (cell.note === 0 || cell.note === XM_KEYOFF_NOTE) return cell;
      const next = Math.max(1, Math.min(96, cell.note + deltaSemitones));
      if (next === cell.note) return cell;
      rowChanged = true;
      return { ...cell, note: next };
    });
    if (!rowChanged) return row;
    patternChanged = true;
    return newRow;
  });

  if (!patternChanged) return song;
  const newPatterns: XmPattern[] = [...song.patterns];
  newPatterns[patIdx] = { rows: newRows, rowCount: pattern.rowCount };
  return { ...song, patterns: newPatterns };
}

/**
 * Replace the pattern's row count. Adds empty rows when growing,
 * trims tail rows when shrinking. The displaced rows are dropped —
 * undo via the editor history restores them.
 */
export function setXmPatternRowCount(
  song: XmSong,
  patternIndex: number,
  rowCount: number,
): XmSong {
  if (patternIndex < 0 || patternIndex >= song.patterns.length) return song;
  if (rowCount < XM_MIN_PATTERN_ROWS || rowCount > XM_MAX_PATTERN_ROWS) {
    return song;
  }
  const pattern = song.patterns[patternIndex]!;
  if (pattern.rowCount === rowCount) return song;
  const newRows: XmNote[][] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    if (r < pattern.rowCount) {
      newRows[r] = pattern.rows[r]!;
    } else {
      const blank: XmNote[] = new Array(song.channelCount);
      for (let c = 0; c < song.channelCount; c++) blank[c] = emptyXmNote();
      newRows[r] = blank;
    }
  }
  const newPatterns = [...song.patterns];
  newPatterns[patternIndex] = { rows: newRows, rowCount };
  return { ...song, patterns: newPatterns };
}

/**
 * Set the song-wide channel count. Patterns are widened (empty cells
 * appended) or trimmed (tail channels dropped). Refuses values outside
 * 2..32.
 */
export function setXmChannelCount(song: XmSong, channelCount: number): XmSong {
  if (channelCount < 2 || channelCount > XM_MAX_CHANNELS) return song;
  if (channelCount === song.channelCount) return song;
  const newPatterns = song.patterns.map((p) =>
    resizePatternChannels(p, channelCount),
  );
  return { ...song, channelCount, patterns: newPatterns };
}

function resizePatternChannels(
  p: XmPattern,
  newChannelCount: number,
): XmPattern {
  const newRows: XmNote[][] = new Array(p.rowCount);
  for (let r = 0; r < p.rowCount; r++) {
    const oldRow = p.rows[r]!;
    const newRow: XmNote[] = new Array(newChannelCount);
    for (let c = 0; c < newChannelCount; c++) {
      newRow[c] = oldRow[c] ?? emptyXmNote();
    }
    newRows[r] = newRow;
  }
  return { rows: newRows, rowCount: p.rowCount };
}

/**
 * Step the pattern number at `order` by +1, growing the patterns array
 * with a fresh empty pattern when the slot would wrap past the end —
 * matches PT2's `nextPatternAtOrder` semantics so the FT2 keybind feels
 * the same. No-op when the order is out of range.
 */
export const nextXmPatternAtOrder = orderOps.nextPatternAtOrder;

/** Step the pattern number at `order` by -1, clamped at 0. */
export const prevXmPatternAtOrder = orderOps.prevPatternAtOrder;

/**
 * Append a fresh empty pattern and point `song.orders[order]` at it.
 * The previously-pointed-at pattern stays in the bank — other slots may
 * still reference it.
 */
export const newXmPatternAtOrder = orderOps.newPatternAtOrder;

/**
 * Append a deep copy of the current pattern and point `order` at it.
 * Lets the user fork-edit a pattern from a known starting point without
 * touching the original.
 */
export const duplicateXmPatternAtOrder = orderOps.duplicatePatternAtOrder;

/**
 * PT-style insert: duplicate the slot's current pattern number into a
 * new slot at the same index, shifting subsequent orders right. Wraps
 * `insertXmOrder` so callers don't have to read out the pattern number
 * themselves.
 */
export function insertXmOrderAtCursor(
  song: XmSong,
  orderIndex: number,
): XmSong {
  if (orderIndex < 0 || orderIndex >= song.songLength) return song;
  const cur = song.orders[orderIndex] ?? 0;
  return orderOps.insertOrderAt(song, orderIndex, cur);
}

/** Insert a new blank pattern at the given order slot. Pushes following slots
 *  forward; the last slot falls off if songLength was already at the cap. */
export const insertXmOrder = orderOps.insertOrderAt;

/** Delete the order slot, pulling subsequent orders back by one. */
export const deleteXmOrder = orderOps.deleteOrder;

/** Set the pattern number stored at the given order slot. */
export function setXmOrderPattern(
  song: XmSong,
  orderIndex: number,
  patternNumber: number,
): XmSong {
  if (orderIndex < 0 || orderIndex >= song.songLength) return song;
  if (song.orders[orderIndex] === patternNumber) return song;
  const newOrders = [...song.orders];
  newOrders[orderIndex] = patternNumber;
  // Ensure pattern array is long enough (XM-spec: pattern count covers
  // every used pattern). Grow with empty patterns if the user pointed
  // at a slot beyond the current array.
  let newPatterns = song.patterns;
  if (patternNumber >= newPatterns.length) {
    newPatterns = [...newPatterns];
    while (newPatterns.length <= patternNumber) {
      newPatterns.push(emptyXmPattern(64, song.channelCount));
    }
  }
  return { ...song, orders: newOrders, patterns: newPatterns };
}

/**
 * Rename the instrument at a 1-based slot, leaving every other field
 * untouched. Creates a fresh empty instrument if the slot is past the
 * current instruments-array length (XM allows sparse slots up to 128;
 * `setXmInstrument` already handles the grow).
 */
export function renameXmInstrument(
  song: XmSong,
  slot1Based: number,
  name: string,
): XmSong {
  const slot = slot1Based - 1;
  if (slot < 0 || slot >= XM_MAX_INSTRUMENTS) return song;
  const existing = song.instruments[slot];
  const trimmed = name.slice(0, XM_INSTRUMENT_NAME_MAX);
  if (existing && existing.name === trimmed) return song;
  const next: XmInstrument = existing
    ? { ...existing, name: trimmed }
    : {
        name: trimmed,
        samples: [],
        keyMap: new Uint8Array(96),
        volumeEnvelope: emptyEnvelopeStub(),
        panningEnvelope: emptyPanningEnvelopeStub(),
        vibratoType: "sine",
        vibratoSweep: 0,
        vibratoDepth: 0,
        vibratoRate: 0,
        fadeout: 0,
      };
  return setXmInstrument(song, slot, next);
}

/** Replace the instrument at a 0-based slot. Grows the array as needed. */
/**
 * Wipe an instrument slot. Replaces the contents with a fresh-empty
 * `emptyXmInstrument()` (zero-data sample, default envelopes, no
 * autovibrato), giving the user a slate-clean slot back. Used by the
 * "Clear instrument" header action.
 */
export function clearXmInstrument(song: XmSong, slot1Based: number): XmSong {
  const slot = slot1Based - 1;
  if (slot < 0 || slot >= XM_MAX_INSTRUMENTS) return song;
  if (!song.instruments[slot]) return song;
  return setXmInstrument(song, slot, emptyXmInstrument());
}

function cloneXmSample(s: XmSample): XmSample {
  const data: Int8Array | Int16Array =
    s.bits === 8
      ? new Int8Array(s.data as Int8Array)
      : new Int16Array(s.data as Int16Array);
  return { ...s, data };
}

function cloneXmEnvelope(e: XmEnvelope): XmEnvelope {
  return { ...e, points: e.points.map((p) => ({ ...p })) };
}

function cloneXmInstrument(inst: XmInstrument, name: string): XmInstrument {
  return {
    ...inst,
    name,
    samples: inst.samples.map(cloneXmSample),
    keyMap: new Uint8Array(inst.keyMap),
    volumeEnvelope: cloneXmEnvelope(inst.volumeEnvelope),
    panningEnvelope: cloneXmEnvelope(inst.panningEnvelope),
  };
}

/**
 * Deep-copy the instrument at `sourceSlot1Based` into
 * `targetSlot1Based`. Appends " copy" to the source name (trimmed to
 * the 22-char XM limit). No-op if the source slot is empty or either
 * slot is out of range.
 */
export function duplicateXmInstrument(
  song: XmSong,
  sourceSlot1Based: number,
  targetSlot1Based: number,
): XmSong {
  const sourceSlot = sourceSlot1Based - 1;
  const targetSlot = targetSlot1Based - 1;
  if (sourceSlot < 0 || sourceSlot >= XM_MAX_INSTRUMENTS) return song;
  if (targetSlot < 0 || targetSlot >= XM_MAX_INSTRUMENTS) return song;
  const src = song.instruments[sourceSlot];
  if (!src) return song;
  const copyName =
    src.name.length > 0
      ? `${src.name} copy`.slice(0, XM_INSTRUMENT_NAME_MAX)
      : "copy";
  return setXmInstrument(song, targetSlot, cloneXmInstrument(src, copyName));
}

export function setXmInstrument(
  song: XmSong,
  slot: number,
  instrument: XmInstrument,
): XmSong {
  if (slot < 0 || slot >= XM_MAX_INSTRUMENTS) return song;
  const newInstruments = [...song.instruments];
  while (newInstruments.length <= slot) {
    // Grow with empty stand-in instruments — caller will overwrite slot
    // anyway, but the array must be contiguous.
    newInstruments.push({
      name: "",
      samples: [],
      keyMap: new Uint8Array(96),
      volumeEnvelope: emptyEnvelopeStub(),
      panningEnvelope: emptyPanningEnvelopeStub(),
      vibratoType: "sine",
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
      fadeout: 0,
    });
  }
  newInstruments[slot] = instrument;
  return { ...song, instruments: newInstruments };
}

/** Volume envelope stub for newly-instantiated instruments. Mirrors
 *  `defaultXmEnvelope(64)` — two flat points at full volume. */
function emptyEnvelopeStub(): XmInstrument["volumeEnvelope"] {
  return defaultXmEnvelope(64);
}
function emptyPanningEnvelopeStub(): XmInstrument["panningEnvelope"] {
  return defaultXmEnvelope(32);
}

// ─── Instrument-level mutations (Phase 4) ──────────────────────────────────
//
// Each setter takes a 1-based instrument slot to match the UI conventions
// (instrument 0 = "no instrument change" in a cell, so the slot numbering
// starts at 1 throughout the editor). They no-op cleanly when the slot is
// out of range or the field already matches.

type InstrumentEnvelopeKind = "volume" | "panning";

function withInstrumentAt(
  song: XmSong,
  slot1Based: number,
  transform: (inst: XmInstrument) => XmInstrument,
): XmSong {
  const slot = slot1Based - 1;
  if (slot < 0 || slot >= XM_MAX_INSTRUMENTS) return song;
  const existing =
    song.instruments[slot] ??
    ({
      name: "",
      samples: [],
      keyMap: new Uint8Array(96),
      volumeEnvelope: emptyEnvelopeStub(),
      panningEnvelope: emptyPanningEnvelopeStub(),
      vibratoType: "sine",
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
      fadeout: 0,
    } satisfies XmInstrument);
  const next = transform(existing);
  if (next === existing) return song;
  return setXmInstrument(song, slot, next);
}

/** Patch one of the two instrument envelopes. */
export function patchXmInstrumentEnvelope(
  song: XmSong,
  slot1Based: number,
  kind: InstrumentEnvelopeKind,
  patch: Partial<XmEnvelope>,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const key = kind === "volume" ? "volumeEnvelope" : "panningEnvelope";
    const current = inst[key];
    const merged: XmEnvelope = { ...current, ...patch };
    // Loop invariant: start ≤ end. Honour the caller's intent — when
    // patching loopStart, clamp it to the current loopEnd; when
    // patching loopEnd, clamp it up to loopStart. When both are in the
    // patch, reject the change entirely if invalid (callers can resend
    // a consistent pair).
    if (
      patch.loopStart !== undefined &&
      patch.loopEnd === undefined &&
      merged.loopStart > merged.loopEnd
    ) {
      return inst;
    }
    if (
      patch.loopEnd !== undefined &&
      patch.loopStart === undefined &&
      merged.loopEnd < merged.loopStart
    ) {
      return inst;
    }
    if (
      patch.loopStart !== undefined &&
      patch.loopEnd !== undefined &&
      merged.loopStart > merged.loopEnd
    ) {
      return inst;
    }
    if (
      merged.enabled === current.enabled &&
      merged.sustainEnabled === current.sustainEnabled &&
      merged.loopEnabled === current.loopEnabled &&
      merged.sustainPoint === current.sustainPoint &&
      merged.loopStart === current.loopStart &&
      merged.loopEnd === current.loopEnd &&
      merged.points === current.points
    ) {
      return inst;
    }
    return { ...inst, [key]: merged };
  });
}

function clampEnvelopePoint(p: XmEnvelopePoint): XmEnvelopePoint {
  return {
    tick: Math.max(0, Math.min(0xffff, Math.floor(p.tick))),
    value: Math.max(0, Math.min(64, Math.floor(p.value))),
  };
}

/**
 * Replace a single envelope point. Preserves array order — caller is
 * responsible for keeping points monotonic by tick (the UI's drag
 * handler clamps to the surrounding neighbours).
 */
export function setXmEnvelopePoint(
  song: XmSong,
  slot1Based: number,
  kind: InstrumentEnvelopeKind,
  pointIndex: number,
  point: XmEnvelopePoint,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const env = kind === "volume" ? inst.volumeEnvelope : inst.panningEnvelope;
    if (pointIndex < 0 || pointIndex >= env.points.length) return inst;
    const clamped = clampEnvelopePoint(point);
    const existing = env.points[pointIndex]!;
    if (existing.tick === clamped.tick && existing.value === clamped.value) {
      return inst;
    }
    const points = [...env.points];
    points[pointIndex] = clamped;
    const key = kind === "volume" ? "volumeEnvelope" : "panningEnvelope";
    return { ...inst, [key]: { ...env, points } };
  });
}

/**
 * Insert a point at `(tick, value)` while keeping the envelope sorted
 * by tick. No-op when the envelope is at `XM_MAX_ENVELOPE_POINTS`
 * capacity or the proposed tick exactly matches an existing point
 * (duplicates would break the monotonic invariant). Sustain / loop
 * indices that sit at or past the insertion index shift up so they
 * keep pointing at the same logical point.
 */
export function addXmEnvelopePoint(
  song: XmSong,
  slot1Based: number,
  kind: InstrumentEnvelopeKind,
  point: XmEnvelopePoint,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const env = kind === "volume" ? inst.volumeEnvelope : inst.panningEnvelope;
    if (env.points.length >= XM_MAX_ENVELOPE_POINTS) return inst;
    const clamped = clampEnvelopePoint(point);
    // Find insertion index: smallest i such that points[i].tick > clamped.tick.
    let insertAt = env.points.length;
    for (let i = 0; i < env.points.length; i++) {
      if (env.points[i]!.tick === clamped.tick) return inst;
      if (env.points[i]!.tick > clamped.tick) {
        insertAt = i;
        break;
      }
    }
    const points = [
      ...env.points.slice(0, insertAt),
      clamped,
      ...env.points.slice(insertAt),
    ];
    const key = kind === "volume" ? "volumeEnvelope" : "panningEnvelope";
    const shift = (idx: number) => (idx >= insertAt ? idx + 1 : idx);
    return {
      ...inst,
      [key]: {
        ...env,
        points,
        sustainPoint: shift(env.sustainPoint),
        loopStart: shift(env.loopStart),
        loopEnd: shift(env.loopEnd),
      },
    };
  });
}

/**
 * Remove a point. Sustain / loop indices that point at or past the
 * removed point shift down to stay valid; indices before it are
 * unchanged.
 */
export function removeXmEnvelopePoint(
  song: XmSong,
  slot1Based: number,
  kind: InstrumentEnvelopeKind,
  pointIndex: number,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const env = kind === "volume" ? inst.volumeEnvelope : inst.panningEnvelope;
    if (pointIndex < 0 || pointIndex >= env.points.length) return inst;
    const points = env.points.filter((_, i) => i !== pointIndex);
    const shift = (idx: number) =>
      idx > pointIndex
        ? idx - 1
        : idx === pointIndex
          ? Math.max(0, idx - 1)
          : idx;
    const next: XmEnvelope = {
      ...env,
      points,
      sustainPoint: shift(env.sustainPoint),
      loopStart: shift(env.loopStart),
      loopEnd: shift(env.loopEnd),
    };
    const key = kind === "volume" ? "volumeEnvelope" : "panningEnvelope";
    return { ...inst, [key]: next };
  });
}

/** Patch autovibrato fields (type / sweep / depth / rate). */
export function patchXmInstrumentAutoVibrato(
  song: XmSong,
  slot1Based: number,
  patch: Partial<
    Pick<
      XmInstrument,
      "vibratoType" | "vibratoSweep" | "vibratoDepth" | "vibratoRate"
    >
  >,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const next: XmInstrument = {
      ...inst,
      ...patch,
      vibratoSweep:
        patch.vibratoSweep !== undefined
          ? Math.max(0, Math.min(0xff, Math.floor(patch.vibratoSweep)))
          : inst.vibratoSweep,
      vibratoDepth:
        patch.vibratoDepth !== undefined
          ? Math.max(0, Math.min(15, Math.floor(patch.vibratoDepth)))
          : inst.vibratoDepth,
      vibratoRate:
        patch.vibratoRate !== undefined
          ? Math.max(0, Math.min(63, Math.floor(patch.vibratoRate)))
          : inst.vibratoRate,
    };
    if (
      next.vibratoType === inst.vibratoType &&
      next.vibratoSweep === inst.vibratoSweep &&
      next.vibratoDepth === inst.vibratoDepth &&
      next.vibratoRate === inst.vibratoRate
    ) {
      return inst;
    }
    return next;
  });
}

/** Set the 16-bit fadeout amount (subtracted per tick from fadevol). */
export function setXmInstrumentFadeout(
  song: XmSong,
  slot1Based: number,
  fadeout: number,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const next = Math.max(0, Math.min(0xfff, Math.floor(fadeout)));
    if (next === inst.fadeout) return inst;
    return { ...inst, fadeout: next };
  });
}

/**
 * Patch the inner sample at `sampleIndex` (default 0). Field-level patch
 * so the UI can flip loop type, finetune, volume, panning, relative
 * note, etc. without rewriting unrelated fields. Sample data and
 * bit-depth stay put — those go through sample-import paths.
 */
export function patchXmInstrumentSample(
  song: XmSong,
  slot1Based: number,
  patch: Partial<
    Pick<
      XmSample,
      | "name"
      | "volume"
      | "finetune"
      | "panning"
      | "relativeNote"
      | "loopType"
      | "loopStart"
      | "loopLength"
    >
  >,
  sampleIndex = 0,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const sample = inst.samples[sampleIndex];
    if (!sample) return inst;
    const clamp = (n: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, Math.floor(n)));
    const dataLen = sample.data.length;
    // Loop fields clamp against the sample's frame count so a drag past
    // the buffer end can't poison the song with `loopStart=40000` on a
    // 400-frame sample. The patch may update both start and length in
    // one call, so resolve them in order: start first, then length
    // against the remaining tail.
    const nextLoopStart =
      patch.loopStart !== undefined
        ? clamp(patch.loopStart, 0, dataLen)
        : sample.loopStart;
    const nextLoopLength =
      patch.loopLength !== undefined
        ? clamp(patch.loopLength, 0, Math.max(0, dataLen - nextLoopStart))
        : Math.min(sample.loopLength, Math.max(0, dataLen - nextLoopStart));
    const next: XmSample = {
      ...sample,
      ...(patch.name !== undefined ? { name: patch.name.slice(0, 22) } : {}),
      ...(patch.volume !== undefined
        ? { volume: clamp(patch.volume, 0, 64) }
        : {}),
      ...(patch.finetune !== undefined
        ? { finetune: clamp(patch.finetune, -128, 127) }
        : {}),
      ...(patch.panning !== undefined
        ? { panning: clamp(patch.panning, 0, 255) }
        : {}),
      ...(patch.relativeNote !== undefined
        ? { relativeNote: clamp(patch.relativeNote, -96, 95) }
        : {}),
      ...(patch.loopType !== undefined ? { loopType: patch.loopType } : {}),
      ...(patch.loopStart !== undefined ? { loopStart: nextLoopStart } : {}),
      ...(patch.loopLength !== undefined ? { loopLength: nextLoopLength } : {}),
    };
    if (
      next.name === sample.name &&
      next.volume === sample.volume &&
      next.finetune === sample.finetune &&
      next.panning === sample.panning &&
      next.relativeNote === sample.relativeNote &&
      next.loopType === sample.loopType &&
      next.loopStart === sample.loopStart &&
      next.loopLength === sample.loopLength
    ) {
      return inst;
    }
    const samples: XmSample[] = [...inst.samples];
    samples[sampleIndex] = next;
    return { ...inst, samples };
  });
}

/**
 * Replace (or set, if the instrument has no sample at that index yet)
 * the sample at `sampleIndex`. The sample brings its own data + bits
 * along — used after a fresh WAV import. Other samples and instrument
 * fields stay intact. When the index points one past the end, the
 * sample is appended.
 */
export function setXmInstrumentSample(
  song: XmSong,
  slot1Based: number,
  sample: XmSample,
  sampleIndex = 0,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    if (sampleIndex < 0) return inst;
    if (
      sampleIndex < inst.samples.length &&
      inst.samples[sampleIndex] === sample
    ) {
      return inst;
    }
    const samples: XmSample[] = [...inst.samples];
    while (samples.length <= sampleIndex) samples.push(emptyXmSample());
    samples[sampleIndex] = sample;
    return { ...inst, samples };
  });
}

/**
 * Append a fresh empty sample to the instrument's sample list. XM
 * permits up to 16 samples per instrument; we mirror that cap. No-op
 * when the cap is already reached.
 */
export function addXmInstrumentSample(
  song: XmSong,
  slot1Based: number,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    if (inst.samples.length >= 16) return inst;
    return { ...inst, samples: [...inst.samples, emptyXmSample()] };
  });
}

/**
 * Remove the sample at `sampleIndex`. Any keyMap entries that pointed
 * at the removed sample re-anchor to sample 0; entries that pointed at
 * a higher slot shift down by one. Mirrors FT2 / OpenMPT semantics.
 * No-op when removing would empty the sample list (every instrument
 * must keep at least one sample).
 */
export function removeXmInstrumentSample(
  song: XmSong,
  slot1Based: number,
  sampleIndex: number,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    if (inst.samples.length <= 1) return inst;
    if (sampleIndex < 0 || sampleIndex >= inst.samples.length) return inst;
    const samples = inst.samples.filter((_, i) => i !== sampleIndex);
    const keyMap = new Uint8Array(inst.keyMap);
    for (let i = 0; i < keyMap.length; i++) {
      const v = keyMap[i]!;
      if (v === sampleIndex) keyMap[i] = 0;
      else if (v > sampleIndex) keyMap[i] = v - 1;
    }
    return { ...inst, samples, keyMap };
  });
}

/**
 * Replace the instrument's 96-byte note → sample-index map. Each entry
 * is clamped to a valid sample slot at write time, so a saved map
 * that out-survives a sample removal stays self-consistent. Copies the
 * input so the caller's buffer is free to mutate.
 */
export function setXmInstrumentKeyMap(
  song: XmSong,
  slot1Based: number,
  keyMap: Uint8Array,
): XmSong {
  return withInstrumentAt(song, slot1Based, (inst) => {
    const maxIdx = inst.samples.length > 0 ? inst.samples.length - 1 : 0;
    const fresh = new Uint8Array(96);
    for (let i = 0; i < 96; i++) {
      fresh[i] = Math.max(0, Math.min(maxIdx, keyMap[i] ?? 0));
    }
    // Skip identity assignment.
    let changed = false;
    for (let i = 0; i < 96; i++) {
      if (fresh[i] !== inst.keyMap[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return inst;
    return { ...inst, keyMap: fresh };
  });
}
