import { describe, expect, it } from "vitest";

import {
  COMPRESSED_BIT,
  FLAG_EFFECT,
  FLAG_EFFECT_PARAM,
  FLAG_INSTRUMENT,
  FLAG_NOTE,
  FLAG_VOLUME,
  packCell,
  unpackCell,
} from "~/core/xm/packing";
import type { XmNote } from "~/core/xm/types";

const empty: XmNote = {
  note: 0,
  instrument: 0,
  volumeColumn: 0,
  effect: 0,
  effectParam: 0,
};

function cell(
  note: number,
  instrument = 0,
  volumeColumn = 0,
  effect = 0,
  effectParam = 0,
): XmNote {
  return { note, instrument, volumeColumn, effect, effectParam };
}

describe("XM cell packing", () => {
  it("encodes an empty cell as a single 0x80 byte", () => {
    const blob = packCell(empty);
    expect(Array.from(blob)).toEqual([COMPRESSED_BIT]);
  });

  it("packs only the present fields in compressed form", () => {
    const blob = packCell(cell(48, 0, 0, 0, 0));
    expect(blob.byteLength).toBe(2);
    expect(blob[0]).toBe(COMPRESSED_BIT | FLAG_NOTE);
    expect(blob[1]).toBe(48);
  });

  it("packs note + instrument + volume in compressed form", () => {
    const blob = packCell(cell(60, 5, 0x70));
    expect(blob[0]).toBe(
      COMPRESSED_BIT | FLAG_NOTE | FLAG_INSTRUMENT | FLAG_VOLUME,
    );
    expect(Array.from(blob.subarray(1))).toEqual([60, 5, 0x70]);
  });

  it("uses uncompressed form when all five fields are present", () => {
    const c = cell(60, 5, 0x70, 0x0a, 0x44);
    const blob = packCell(c);
    expect(blob.byteLength).toBe(5);
    // Note has bit 7 clear → recogniser reads as uncompressed.
    expect(blob[0]).toBe(60);
    expect(Array.from(blob)).toEqual([60, 5, 0x70, 0x0a, 0x44]);
  });

  it("round-trips a fully-populated cell", () => {
    const c = cell(72, 12, 0x65, 0x0c, 0xff);
    const blob = packCell(c);
    const { cell: out, consumed } = unpackCell(blob, 0);
    expect(consumed).toBe(blob.byteLength);
    expect(out).toEqual(c);
  });

  it("round-trips a sparse cell (only effect)", () => {
    const c = cell(0, 0, 0, 0xa, 0x05);
    const blob = packCell(c);
    expect(blob[0]).toBe(COMPRESSED_BIT | FLAG_EFFECT | FLAG_EFFECT_PARAM);
    const { cell: out } = unpackCell(blob, 0);
    expect(out).toEqual(c);
  });

  it("round-trips an empty cell", () => {
    const blob = packCell(empty);
    const { cell: out, consumed } = unpackCell(blob, 0);
    expect(consumed).toBe(1);
    expect(out).toEqual(empty);
  });

  it("decodes a multi-cell stream with a starting offset", () => {
    const a = packCell(cell(48, 1));
    const b = packCell(cell(50, 2));
    const stream = new Uint8Array(a.byteLength + b.byteLength);
    stream.set(a, 0);
    stream.set(b, a.byteLength);
    const first = unpackCell(stream, 0);
    expect(first.cell).toEqual(cell(48, 1));
    const second = unpackCell(stream, first.consumed);
    expect(second.cell).toEqual(cell(50, 2));
  });

  it("throws when the compressed cell runs past the buffer end", () => {
    const truncated = new Uint8Array([COMPRESSED_BIT | FLAG_NOTE]);
    expect(() => unpackCell(truncated, 0)).toThrow();
  });

  it("throws when an uncompressed cell runs past the buffer end", () => {
    // Note=10 (bit 7 clear) needs 4 trailing bytes, only 1 supplied.
    const truncated = new Uint8Array([10, 0]);
    expect(() => unpackCell(truncated, 0)).toThrow();
  });
});
