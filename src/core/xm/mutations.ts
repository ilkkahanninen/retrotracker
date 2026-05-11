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

import { emptyXmNote, emptyXmPattern } from "./format";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_KEYOFF_NOTE,
  XM_MAX_CHANNELS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_ORDERS,
  XM_MAX_PATTERN_ROWS,
  XM_MIN_PATTERN_ROWS,
  type XmInstrument,
  type XmNote,
  type XmPattern,
  type XmSong,
} from "./types";

void XM_KEYOFF_NOTE;

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
export function nextXmPatternAtOrder(song: XmSong, order: number): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const next = cur + 1;
  if (next < song.patterns.length) return setXmOrderPattern(song, order, next);
  const newPatterns: XmPattern[] = [
    ...song.patterns,
    emptyXmPattern(64, song.channelCount),
  ];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/** Step the pattern number at `order` by -1, clamped at 0. */
export function prevXmPatternAtOrder(song: XmSong, order: number): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  if (cur <= 0) return song;
  return setXmOrderPattern(song, order, cur - 1);
}

/**
 * Append a fresh empty pattern and point `song.orders[order]` at it.
 * The previously-pointed-at pattern stays in the bank — other slots may
 * still reference it.
 */
export function newXmPatternAtOrder(song: XmSong, order: number): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const newPatterns: XmPattern[] = [
    ...song.patterns,
    emptyXmPattern(64, song.channelCount),
  ];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

/**
 * Append a deep copy of the current pattern and point `order` at it.
 * Lets the user fork-edit a pattern from a known starting point without
 * touching the original.
 */
export function duplicateXmPatternAtOrder(song: XmSong, order: number): XmSong {
  if (order < 0 || order >= song.songLength) return song;
  const cur = song.orders[order] ?? 0;
  const source = song.patterns[cur];
  if (!source) return song;
  // Deep-clone rows + cells. Cells are immutable in normal use but the
  // user might mutate the copy via setXmCell, so structural sharing of
  // a single row would propagate edits to the original.
  const clonedRows: XmNote[][] = source.rows.map((row) =>
    row.map((cell) => ({ ...cell })),
  );
  const clone: XmPattern = { rows: clonedRows, rowCount: source.rowCount };
  const newPatterns = [...song.patterns, clone];
  const newOrders = [...song.orders];
  newOrders[order] = newPatterns.length - 1;
  return { ...song, patterns: newPatterns, orders: newOrders };
}

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
  return insertXmOrder(song, orderIndex, cur);
}

/** Insert a new blank pattern at the given order slot. Pushes following slots
 *  forward; the last slot falls off if songLength was already at the cap. */
export function insertXmOrder(
  song: XmSong,
  orderIndex: number,
  patternNumber: number,
): XmSong {
  if (orderIndex < 0 || orderIndex > song.songLength) return song;
  if (song.songLength >= XM_MAX_ORDERS) return song;
  const newOrders = [...song.orders];
  for (let i = song.songLength; i > orderIndex; i--) {
    newOrders[i] = newOrders[i - 1]!;
  }
  newOrders[orderIndex] = patternNumber;
  return { ...song, songLength: song.songLength + 1, orders: newOrders };
}

/** Delete the order slot, pulling subsequent orders back by one. */
export function deleteXmOrder(song: XmSong, orderIndex: number): XmSong {
  if (orderIndex < 0 || orderIndex >= song.songLength) return song;
  if (song.songLength <= 1) return song;
  const newOrders = [...song.orders];
  for (let i = orderIndex; i < song.songLength - 1; i++) {
    newOrders[i] = newOrders[i + 1]!;
  }
  newOrders[song.songLength - 1] = 0;
  return { ...song, songLength: song.songLength - 1, orders: newOrders };
}

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
        panningEnvelope: emptyEnvelopeStub(),
        vibratoType: "sine",
        vibratoSweep: 0,
        vibratoDepth: 0,
        vibratoRate: 0,
        fadeout: 0,
      };
  return setXmInstrument(song, slot, next);
}

/** Replace the instrument at a 0-based slot. Grows the array as needed. */
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
      panningEnvelope: emptyEnvelopeStub(),
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

function emptyEnvelopeStub(): XmInstrument["volumeEnvelope"] {
  return {
    enabled: false,
    sustainEnabled: false,
    loopEnabled: false,
    sustainPoint: 0,
    loopStart: 0,
    loopEnd: 0,
    points: [],
  };
}
