import { describe, expect, it } from "vitest";
import { deriveExportFilename } from "../src/state/io";

describe("deriveExportFilename", () => {
  it("uses the loaded filename verbatim when it ends in .mod", () => {
    expect(deriveExportFilename("song.mod", "")).toBe("song.mod");
  });

  it("normalises the .mod extension case", () => {
    expect(deriveExportFilename("Song.MOD", "")).toBe("Song.mod");
  });

  it("appends .mod when the loaded filename has no extension", () => {
    expect(deriveExportFilename("song", "")).toBe("song.mod");
  });

  it("falls back to the song title when no file was loaded", () => {
    expect(deriveExportFilename(null, "Demo")).toBe("Demo.mod");
  });

  it('falls back to "untitled" when there is neither a filename nor a title', () => {
    expect(deriveExportFilename(null, "")).toBe("untitled.mod");
    expect(deriveExportFilename(null, "   ")).toBe("untitled.mod");
  });

  it("replaces spaces and unsafe characters in the song title", () => {
    expect(deriveExportFilename(null, "My Cool Song")).toBe("My_Cool_Song.mod");
    expect(deriveExportFilename(null, "Cool/Song:1")).toBe("Cool_Song_1.mod");
  });

  it("caps the basename at 64 characters", () => {
    const long = "x".repeat(200);
    const out = deriveExportFilename(null, long);
    // basename ≤ 64, plus ".mod"
    expect(out.length).toBeLessThanOrEqual(64 + 4);
    expect(out.endsWith(".mod")).toBe(true);
  });

  it("preserves the loaded name even if the song title is also set", () => {
    expect(deriveExportFilename("foo.mod", "Bar")).toBe("foo.mod");
  });
});
