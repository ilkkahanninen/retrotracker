import { describe, expect, it } from "vitest";

import {
  deltaDecode16,
  deltaDecode8,
  deltaEncode16,
  deltaEncode8,
} from "~/core/xm/delta";

describe("XM 8-bit delta codec", () => {
  it("decodes the canonical example correctly", () => {
    // First sample is the running prefix sum of the byte stream:
    // 10, 10+5=15, 15-5=10, 10+(-3)=7
    const encoded = new Uint8Array([10, 5, 0xfb, 0xfd]);
    const decoded = deltaDecode8(encoded);
    expect(Array.from(decoded)).toEqual([10, 15, 10, 7]);
  });

  it("round-trips Int8Array data exactly", () => {
    const original = new Int8Array([0, 50, -50, 127, -128, 0, 1, -1, 64, -64]);
    const encoded = deltaEncode8(original);
    const decoded = deltaDecode8(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("handles a constant signal (all-zero deltas after the first byte)", () => {
    const original = new Int8Array(20).fill(42);
    const encoded = deltaEncode8(original);
    expect(encoded[0]).toBe(42);
    for (let i = 1; i < encoded.length; i++) expect(encoded[i]).toBe(0);
    const decoded = deltaDecode8(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("handles wrap-around at the int8 boundary", () => {
    // 127 + 1 wraps to -128 in signed int8 (modular arithmetic).
    const original = new Int8Array([127, -128]);
    const encoded = deltaEncode8(original);
    expect(encoded[0]).toBe(127);
    expect(encoded[1]).toBe(1);
    expect(Array.from(deltaDecode8(encoded))).toEqual([127, -128]);
  });

  it("returns an empty array for empty input", () => {
    expect(deltaEncode8(new Int8Array(0))).toEqual(new Uint8Array(0));
    expect(deltaDecode8(new Uint8Array(0))).toEqual(new Int8Array(0));
  });
});

describe("XM 16-bit delta codec", () => {
  it("round-trips Int16Array data exactly", () => {
    const original = new Int16Array([
      0, 12345, -12345, 32767, -32768, 0, 1, -1, 16000, -16000,
    ]);
    const encoded = deltaEncode16(original);
    expect(encoded.byteLength).toBe(original.length * 2);
    const decoded = deltaDecode16(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("encodes a constant signal as zero deltas", () => {
    const original = new Int16Array(8).fill(1000);
    const encoded = deltaEncode16(original);
    // First two bytes = 1000 little-endian
    expect(encoded[0]).toBe(1000 & 0xff);
    expect(encoded[1]).toBe(1000 >>> 8);
    for (let i = 2; i < encoded.length; i++) expect(encoded[i]).toBe(0);
  });
});
