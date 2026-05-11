import { describe, expect, it } from "vitest";

import { isXmFile } from "~/core/xm/sniff";
import { emptyXmSong } from "~/core/xm/format";

describe("XM byte sniff", () => {
  it("recognises the canonical magic", () => {
    const magic = "Extended Module: Test name";
    const bytes = new TextEncoder().encode(magic);
    expect(isXmFile(bytes)).toBe(true);
  });

  it("rejects files that don't start with the magic", () => {
    const bytes = new TextEncoder().encode("Not an XM file");
    expect(isXmFile(bytes)).toBe(false);
  });

  it("rejects files shorter than the magic", () => {
    const bytes = new TextEncoder().encode("Short");
    expect(isXmFile(bytes)).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isXmFile(new Uint8Array(0))).toBe(false);
  });
});

describe("emptyXmSong factory", () => {
  it("stamps the FT2 discriminator", () => {
    expect(emptyXmSong().format).toBe("FT2");
  });

  it("creates a default-channel single-pattern song", () => {
    const xm = emptyXmSong();
    expect(xm.channelCount).toBeGreaterThanOrEqual(2);
    expect(xm.channelCount).toBeLessThanOrEqual(32);
    expect(xm.patterns).toHaveLength(1);
    expect(xm.patterns[0]!.rows).toHaveLength(xm.patterns[0]!.rowCount);
    expect(xm.patterns[0]!.rows[0]).toHaveLength(xm.channelCount);
  });

  it("starts with no instruments", () => {
    expect(emptyXmSong().instruments).toEqual([]);
  });

  it("defaults to the linear frequency table", () => {
    expect(emptyXmSong().flags.linearFreq).toBe(true);
  });
});
