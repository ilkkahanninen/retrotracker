/**
 * XM pattern-cell packing.
 *
 * Each cell carries (note, instrument, volumeColumn, effect, effectParam).
 * On disk it's encoded one of two ways:
 *
 * - **Compressed**: first byte has bit 7 set. Bits 0..4 indicate which
 *   fields follow (1=note, 2=inst, 4=vol, 8=fxType, 16=fxParam). Absent
 *   fields default to 0. An empty cell packs as a single 0x80 byte.
 * - **Uncompressed**: first byte has bit 7 clear. The byte itself is the
 *   note (1..97), and the next four bytes are inst / vol / fxType / fxParam
 *   in order. So a fully-populated cell with bit 7 clear on the note is
 *   always five bytes.
 *
 * FT2's writer always emits the compressed form for any cell with at
 * least one absent field. Our writer mirrors that — it produces a byte
 * stream that round-trips through any reader compliant with the spec.
 */

import type { XmNote } from "./types";

export const COMPRESSED_BIT = 0x80;
export const FLAG_NOTE = 0x01;
export const FLAG_INSTRUMENT = 0x02;
export const FLAG_VOLUME = 0x04;
export const FLAG_EFFECT = 0x08;
export const FLAG_EFFECT_PARAM = 0x10;

/**
 * Decode one packed cell at `off`. Returns the cell + the number of
 * bytes consumed. Throws if the buffer is too short for the encoded
 * shape.
 */
export function unpackCell(
  bytes: Uint8Array,
  off: number,
): { cell: XmNote; consumed: number } {
  if (off >= bytes.length) {
    throw new Error("Pattern data truncated");
  }
  const head = bytes[off]!;
  if ((head & COMPRESSED_BIT) === 0) {
    // Uncompressed: head is the note, next 4 bytes are the rest.
    if (off + 5 > bytes.length) {
      throw new Error("Pattern cell truncated (uncompressed form)");
    }
    return {
      cell: {
        note: head,
        instrument: bytes[off + 1]!,
        volumeColumn: bytes[off + 2]!,
        effect: bytes[off + 3]!,
        effectParam: bytes[off + 4]!,
      },
      consumed: 5,
    };
  }
  let cursor = off + 1;
  const cell: XmNote = {
    note: 0,
    instrument: 0,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
  };
  const fields: ReadonlyArray<[number, keyof XmNote]> = [
    [FLAG_NOTE, "note"],
    [FLAG_INSTRUMENT, "instrument"],
    [FLAG_VOLUME, "volumeColumn"],
    [FLAG_EFFECT, "effect"],
    [FLAG_EFFECT_PARAM, "effectParam"],
  ];
  for (const [flag, key] of fields) {
    if ((head & flag) !== 0) {
      if (cursor >= bytes.length) {
        throw new Error("Pattern cell truncated (compressed form)");
      }
      cell[key] = bytes[cursor]!;
      cursor++;
    }
  }
  return { cell, consumed: cursor - off };
}

/**
 * Encode one cell. Always uses the compressed form unless the cell is
 * fully populated (all five fields non-zero) — there the compressed form
 * is one byte longer than the uncompressed (1 head + 5 fields = 6 bytes
 * vs. 5 bytes raw), so we drop into the uncompressed path. Mirrors
 * FT2's writer behaviour.
 */
export function packCell(cell: XmNote): Uint8Array {
  const allPresent =
    cell.note !== 0 &&
    cell.instrument !== 0 &&
    cell.volumeColumn !== 0 &&
    cell.effect !== 0 &&
    cell.effectParam !== 0;
  if (allPresent && cell.note < COMPRESSED_BIT) {
    return new Uint8Array([
      cell.note,
      cell.instrument,
      cell.volumeColumn,
      cell.effect,
      cell.effectParam,
    ]);
  }
  let head = COMPRESSED_BIT;
  const tail: number[] = [];
  if (cell.note !== 0) {
    head |= FLAG_NOTE;
    tail.push(cell.note);
  }
  if (cell.instrument !== 0) {
    head |= FLAG_INSTRUMENT;
    tail.push(cell.instrument);
  }
  if (cell.volumeColumn !== 0) {
    head |= FLAG_VOLUME;
    tail.push(cell.volumeColumn);
  }
  if (cell.effect !== 0) {
    head |= FLAG_EFFECT;
    tail.push(cell.effect);
  }
  if (cell.effectParam !== 0) {
    head |= FLAG_EFFECT_PARAM;
    tail.push(cell.effectParam);
  }
  return new Uint8Array([head, ...tail]);
}
