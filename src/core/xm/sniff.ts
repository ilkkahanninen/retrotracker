/** "Extended Module: " — XM file magic at offset 0. */
const XM_MAGIC = "Extended Module: ";

/**
 * Cheap byte-sniff. The first 17 bytes of any FT2 .xm file are the literal
 * ASCII "Extended Module: " (with a trailing space). Used by `loadFile`
 * to pick the right parser when the user opens an unknown file.
 */
export function isXmFile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < XM_MAGIC.length) return false;
  for (let i = 0; i < XM_MAGIC.length; i++) {
    if (bytes[i] !== XM_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
