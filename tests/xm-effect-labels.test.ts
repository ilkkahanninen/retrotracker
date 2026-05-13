import { describe, expect, it } from "vitest";

import {
  decodeVolumeColumn,
  effectChar,
  effectCodeForChar,
  noteString,
} from "~/core/xm/effectLabels";

describe("XM effect column labels", () => {
  it("renders 0..F for the PT-overlap range", () => {
    expect(effectChar(0x00)).toBe("0");
    expect(effectChar(0x05)).toBe("5");
    expect(effectChar(0x0a)).toBe("A");
    expect(effectChar(0x0f)).toBe("F");
  });

  it("renders FT2-only commands by their letter", () => {
    expect(effectChar(0x10)).toBe("G"); // global volume
    expect(effectChar(0x14)).toBe("K"); // key off
    expect(effectChar(0x19)).toBe("P"); // pan slide
    expect(effectChar(0x1d)).toBe("T"); // tremor
    expect(effectChar(0x21)).toBe("X"); // X-extended
  });

  it("returns '.' for unmapped codes", () => {
    expect(effectChar(0x99)).toBe(".");
  });

  it("effectCodeForChar inverts effectChar", () => {
    for (let code = 0; code <= 0x21; code++) {
      const ch = effectChar(code);
      // Skip "I", "J", "M", "N", "O", "Q", "S", "U", "V", "W" — they appear
      // in the table for visual indexing but the inverse looks them up too.
      expect(effectCodeForChar(ch)).toBe(code);
    }
  });

  it("effectCodeForChar is case-insensitive and rejects nonsense", () => {
    expect(effectCodeForChar("a")).toBe(0x0a);
    expect(effectCodeForChar("A")).toBe(0x0a);
    expect(effectCodeForChar("?")).toBeNull();
  });
});

describe("XM volume column decode", () => {
  it("returns null for empty bytes", () => {
    expect(decodeVolumeColumn(0)).toBeNull();
  });

  it("decodes the 0x10..0x50 set-volume range as kind=hex digit", () => {
    // The cell is exactly two chars wide; for set-volume FT2 displays
    // the byte's high nibble + low nibble verbatim (no `v` prefix).
    expect(decodeVolumeColumn(0x10)).toEqual({ kind: "1", magnitude: 0 });
    expect(decodeVolumeColumn(0x40)).toEqual({ kind: "4", magnitude: 0 });
    expect(decodeVolumeColumn(0x4f)).toEqual({ kind: "4", magnitude: 0xf });
    expect(decodeVolumeColumn(0x50)).toEqual({ kind: "5", magnitude: 0 });
  });

  it("decodes vol slide / fine slide / vibrato / pan / porta", () => {
    expect(decodeVolumeColumn(0x65)?.kind).toBe("-");
    expect(decodeVolumeColumn(0x75)?.kind).toBe("+");
    expect(decodeVolumeColumn(0x85)?.kind).toBe("D");
    expect(decodeVolumeColumn(0x95)?.kind).toBe("U");
    expect(decodeVolumeColumn(0xa5)?.kind).toBe("S");
    expect(decodeVolumeColumn(0xb5)?.kind).toBe("V");
    expect(decodeVolumeColumn(0xc5)?.kind).toBe("P");
    expect(decodeVolumeColumn(0xd5)?.kind).toBe("L");
    expect(decodeVolumeColumn(0xe5)?.kind).toBe("R");
    expect(decodeVolumeColumn(0xf5)?.kind).toBe("M");
  });
});

describe("XM note rendering", () => {
  it("formats notes 1..96 as C-0..B-7", () => {
    expect(noteString(1)).toBe("C-0");
    expect(noteString(13)).toBe("C-1");
    expect(noteString(49)).toBe("C-4");
    expect(noteString(96)).toBe("B-7");
  });

  it('renders 0 as "..." and 97 (key-off) as "==."', () => {
    expect(noteString(0)).toBe("...");
    expect(noteString(97)).toBe("==.");
  });

  it("renders sharp notes with #", () => {
    // Note 2 (1-based) = C#0
    expect(noteString(2)).toBe("C#0");
  });
});
