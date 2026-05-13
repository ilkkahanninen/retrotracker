/**
 * Little-endian byte helpers for the XM parser. The MOD parser reads
 * big-endian (Amiga / 68k); XM is x86 / FT2-native and reads little-endian.
 * We keep these helpers separate from the MOD ones so neither file's
 * intent is muddled.
 */

export function readU8(u8: Uint8Array, off: number): number {
  return u8[off]!;
}

export function readU16LE(u8: Uint8Array, off: number): number {
  return u8[off]! | (u8[off + 1]! << 8);
}

export function readU32LE(u8: Uint8Array, off: number): number {
  return (
    (u8[off]! |
      (u8[off + 1]! << 8) |
      (u8[off + 2]! << 16) |
      (u8[off + 3]! << 24)) >>>
    0
  );
}

export function readI8(u8: Uint8Array, off: number): number {
  const v = u8[off]!;
  return v >= 0x80 ? v - 0x100 : v;
}

/** Read a fixed-width ASCII field. Strips trailing 0x00 / 0x20 padding. */
export function readAsciiPadded(
  u8: Uint8Array,
  off: number,
  len: number,
): string {
  let end = off + len;
  while (end > off) {
    const c = u8[end - 1]!;
    if (c !== 0 && c !== 0x20) break;
    end--;
  }
  let s = "";
  for (let i = off; i < end; i++) {
    const c = u8[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "";
  }
  return s;
}

/** Write an ASCII field, padded with `pad` (default 0x00). Truncates at len. */
export function writeAsciiPadded(
  out: Uint8Array,
  off: number,
  len: number,
  s: string,
  pad: number = 0x00,
): void {
  for (let i = 0; i < len; i++) {
    const c = i < s.length ? s.charCodeAt(i) & 0x7f : pad;
    out[off + i] = c;
  }
}

export function writeU8(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
}

export function writeU16LE(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
}

export function writeU32LE(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
}

export function writeI8(out: Uint8Array, off: number, v: number): void {
  out[off] = v < 0 ? (v + 0x100) & 0xff : v & 0xff;
}
