import { describe, expect, it } from "vitest";
import { parseModule } from "../src/core/mod/parser";
import { writeModule } from "../src/core/mod/writer";
import { emptySong } from "../src/core/mod/format";
import type { Note } from "../src/core/mod/types";

describe("MOD round-trip", () => {
  it("serializes and re-parses an empty song", () => {
    const before = emptySong();
    before.title = "hello";
    before.samples[0]!.name = "kick";
    before.samples[0]!.volume = 64;
    before.samples[0]!.lengthWords = 2;
    before.samples[0]!.data = new Int8Array([1, 2, 3, 4]);

    const buf = writeModule(before);
    const after = parseModule(buf);

    expect(after.signature).toBe("M.K.");
    expect(after.title).toBe("hello");
    expect(after.samples[0]!.name).toBe("kick");
    expect(after.samples[0]!.volume).toBe(64);
    expect(after.samples[0]!.lengthWords).toBe(2);
    expect(Array.from(after.samples[0]!.data)).toEqual([1, 2, 3, 4]);
  });

  it("round-trips notes with all four fields", () => {
    const song = emptySong();
    const note: Note = {
      period: 0x123,
      sample: 17,
      effect: 0xc,
      effectParam: 0x40,
    };
    song.patterns[0]!.rows[0]![0] = note;

    const buf = writeModule(song);
    const after = parseModule(buf);
    expect(after.patterns[0]!.rows[0]![0]).toEqual(note);
  });

  it("rejects non-M.K. signatures", () => {
    const song = emptySong();
    const buf = writeModule(song);
    // Stomp the signature.
    buf[1080] = 0x36; // '6'
    buf[1081] = 0x43; // 'C'
    buf[1082] = 0x48; // 'H'
    buf[1083] = 0x4e; // 'N'
    expect(() => parseModule(buf)).toThrow(/Unsupported MOD signature/);
  });
});
