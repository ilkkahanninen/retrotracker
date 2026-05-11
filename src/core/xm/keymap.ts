/**
 * XM instrument key-to-sample map.
 *
 * Each instrument carries a 96-byte map indexed by note 0..95 (C-0..B-7),
 * each entry naming which of the instrument's up-to-16 samples should
 * play for that note. Phase 1 only stores the 96 bytes verbatim;
 * multi-sample-per-instrument lookup turns the indirection on later.
 */

const KEYMAP_SIZE = 96;

export function emptyKeyMap(): Uint8Array {
  return new Uint8Array(KEYMAP_SIZE);
}

/** Reads the 96-byte map at `off`. Returns a fresh Uint8Array (not a view). */
export function readKeyMap(bytes: Uint8Array, off: number): Uint8Array {
  const out = new Uint8Array(KEYMAP_SIZE);
  out.set(bytes.subarray(off, off + KEYMAP_SIZE));
  return out;
}

/** Write the keymap at `off`. Pads / truncates to exactly 96 bytes. */
export function writeKeyMap(
  out: Uint8Array,
  off: number,
  map: Uint8Array,
): void {
  for (let i = 0; i < KEYMAP_SIZE; i++) out[off + i] = map[i] ?? 0;
}

/** Look up which sample-within-instrument plays for a 1-based note. */
export function sampleIndexForNote(map: Uint8Array, note: number): number {
  if (note < 1 || note > 96) return 0;
  return map[note - 1] ?? 0;
}
