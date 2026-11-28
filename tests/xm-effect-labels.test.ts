import { describe, expect, it } from "vitest";

import {
  decodeVolumeColumn,
  volumeColumnSetValue,
  volumeColumnWithDigit,
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

  it("shows a set-volume as the volume itself, not the stored byte", () => {
    // The file stores volume + 0x10. FT2 shows the volume: 00..40.
    expect(decodeVolumeColumn(0x10)).toEqual({ kind: "0", magnitude: 0 });
    expect(decodeVolumeColumn(0x19)).toEqual({ kind: "0", magnitude: 9 });
    expect(decodeVolumeColumn(0x1f)).toEqual({ kind: "0", magnitude: 0xf });
    expect(decodeVolumeColumn(0x20)).toEqual({ kind: "1", magnitude: 0 });
    expect(decodeVolumeColumn(0x4f)).toEqual({ kind: "3", magnitude: 0xf });
    expect(decodeVolumeColumn(0x50)).toEqual({ kind: "4", magnitude: 0 });
  });

  it("volumeColumnSetValue is the volume for set-volume bytes only", () => {
    expect(volumeColumnSetValue(0)).toBeNull();
    expect(volumeColumnSetValue(0x0f)).toBeNull();
    expect(volumeColumnSetValue(0x10)).toBe(0);
    expect(volumeColumnSetValue(0x50)).toBe(64);
    expect(volumeColumnSetValue(0x60)).toBeNull();
    expect(volumeColumnSetValue(0xc8)).toBeNull();
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

describe("typing into the XM volume column", () => {
  const hi = (byte: number, d: number) => volumeColumnWithDigit(byte, "hi", d);
  const lo = (byte: number, d: number) => volumeColumnWithDigit(byte, "lo", d);
  /** Type both characters into an empty cell. */
  const type = (a: number, b: number) => lo(hi(0, a)!, b)!;

  it("enters volumes below 10, down to 00", () => {
    // The reported bug: a leading 0 used to clear the column, so nothing
    // under 0x10 could be typed.
    expect(type(0, 9)).toBe(0x19); // volume 09
    expect(type(0, 0)).toBe(0x10); // volume 00
    expect(type(0, 0xf)).toBe(0x1f); // volume 0F
  });

  it("what is typed is the volume: 40 is full volume", () => {
    expect(type(4, 0)).toBe(0x50);
    expect(type(2, 0)).toBe(0x30);
    expect(type(3, 0xc)).toBe(0x4c);
    for (const [a, b] of [
      [0, 9],
      [1, 0],
      [3, 0xf],
      [4, 0],
    ] as const) {
      expect(volumeColumnSetValue(type(a, b))).toBe((a << 4) | b);
    }
  });

  it("a volume can't go past 40", () => {
    expect(type(4, 7)).toBe(0x50);
    // 3F with the first digit retyped as 4 would be 4F.
    expect(hi(0x4f, 4)).toBe(0x50);
  });

  it("a leading 5 means nothing and is refused", () => {
    expect(hi(0, 5)).toBeNull();
    expect(hi(0x30, 5)).toBeNull();
  });

  it("the first digit keeps the second, and the second keeps the first", () => {
    expect(hi(0x19, 2)).toBe(0x39); // 09 → 29
    expect(lo(0x39, 4)).toBe(0x34); // 29 → 24
  });

  it("the second digit alone on an empty cell is a volume", () => {
    expect(lo(0, 9)).toBe(0x19);
    expect(lo(0, 0)).toBe(0x10);
  });

  it("6..F on the first digit pick an effect; the second digit is its amount", () => {
    expect(type(6, 3)).toBe(0x63); // -3
    expect(type(0xc, 8)).toBe(0xc8); // P8
    expect(decodeVolumeColumn(type(0xf, 2))).toEqual({
      kind: "M",
      magnitude: 2,
    });
    // Editing an effect's amount leaves its kind alone.
    expect(lo(0xc8, 1)).toBe(0xc1);
  });

  it("switching between a volume and an effect keeps the other digit", () => {
    expect(hi(0x63, 2)).toBe(0x33); // -3 → volume 23
    expect(hi(0x33, 7)).toBe(0x73); // volume 23 → +3
  });
});
