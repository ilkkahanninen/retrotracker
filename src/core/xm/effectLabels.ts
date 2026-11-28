/**
 * XM-native labels for effect column + volume column.
 *
 * The user picked XM-native labels in Phase 0 scoping, so the FT2
 * pattern grid renders effect codes as 0..9, A..Z (with the FT2
 * convention that A=0xA, B=0xB, etc., letters skipping over
 * letters that ft2-clone leaves unimplemented). The volume column's
 * high nibble renders as a kind-letter (`-`, `+`, `D`, `U`, ...).
 */

/** Effect-code (0..0x21) → display char. Anything past 0x21 is unmapped. */
const EFFECT_CHAR: ReadonlyArray<string> = [
  "0", // 0x00 Arpeggio
  "1", // 0x01 Slide up
  "2", // 0x02 Slide down
  "3", // 0x03 Tone portamento
  "4", // 0x04 Vibrato
  "5", // 0x05 Tone porta + vol slide
  "6", // 0x06 Vibrato + vol slide
  "7", // 0x07 Tremolo
  "8", // 0x08 Set panning
  "9", // 0x09 Sample offset
  "A", // 0x0A Volume slide
  "B", // 0x0B Position jump
  "C", // 0x0C Set volume
  "D", // 0x0D Pattern break
  "E", // 0x0E Extended (sub-command in param hi nibble)
  "F", // 0x0F Set speed/tempo
  "G", // 0x10 Set global volume
  "H", // 0x11 Global volume slide
  "I", // 0x12 (unused in FT2)
  "J", // 0x13 (unused in FT2)
  "K", // 0x14 Key off
  "L", // 0x15 Set envelope position
  "M", // 0x16 (unused)
  "N", // 0x17 (unused)
  "O", // 0x18 (unused)
  "P", // 0x19 Panning slide
  "Q", // 0x1A (unused)
  "R", // 0x1B Multi retrigger
  "S", // 0x1C (unused)
  "T", // 0x1D Tremor
  "U", // 0x1E (unused)
  "V", // 0x1F (unused)
  "W", // 0x20 (unused)
  "X", // 0x21 X-extended (sub-command in param hi nibble)
];

/** Returns the FT2 display char for an effect code, or "." if unrecognised. */
export function effectChar(code: number): string {
  return EFFECT_CHAR[code] ?? ".";
}

/** Inverse: display char → effect code, or null if not a known label. */
export function effectCodeForChar(char: string): number | null {
  const c = char.toUpperCase();
  const idx = EFFECT_CHAR.indexOf(c);
  return idx < 0 ? null : idx;
}

/**
 * The XM volume column packs (kind, magnitude) into one byte:
 *
 *   0x00        empty
 *   0x10..0x50  set volume 0..64 — stored as the volume PLUS 0x10
 *   0x60..0xFF  an effect: high nibble = kind, low nibble = magnitude
 *
 * The grid shows it as two characters, the way FT2 does: a set-volume
 * as the volume itself in hex (`00`..`40`), an effect as its symbol and
 * magnitude (`-3`, `P8`). The +0x10 is a storage detail the user never
 * sees — showing the raw byte made `40` read as full volume when it
 * plays 0x30, and left no way to type a volume below 0x10.
 */
export const XM_VOL_SET_BASE = 0x10;
export const XM_VOL_MAX = 0x40;

/** First byte of the effect range; below it (and above 0) is set-volume. */
const VOL_EFFECT_BASE = 0x60;

/** Symbols for the effect kinds, indexed by the byte's high nibble. */
const VOL_EFFECT_CHAR: Readonly<Record<number, string>> = {
  0x6: "-", // vol slide down
  0x7: "+", // vol slide up
  0x8: "D", // fine vol slide down
  0x9: "U", // fine vol slide up
  0xa: "S", // vibrato speed
  0xb: "V", // vibrato w/ depth
  0xc: "P", // set panning
  0xd: "L", // pan slide left
  0xe: "R", // pan slide right
  0xf: "M", // tone portamento
};

/** The volume a set-volume byte stands for, or null for any other byte
 *  (empty, an effect, or the meaningless 0x01..0x0F). */
export function volumeColumnSetValue(byte: number): number | null {
  if (byte < XM_VOL_SET_BASE || byte >= VOL_EFFECT_BASE) return null;
  return byte - XM_VOL_SET_BASE;
}

/**
 * Decode the volume column byte into the two characters the grid draws:
 * `kind` (first) and `magnitude` (second, a nibble). Returns `null` for
 * an empty cell (byte === 0).
 *
 * For a set-volume the two are the hex digits of the volume itself, so
 * 0x19 reads `09` and 0x50 reads `40`.
 */
export function decodeVolumeColumn(
  byte: number,
): { kind: string; magnitude: number } | null {
  if (byte === 0) return null;
  const volume = volumeColumnSetValue(byte);
  if (volume !== null) {
    return {
      kind: (volume >>> 4).toString(16).toUpperCase(),
      magnitude: volume & 0xf,
    };
  }
  return {
    kind: VOL_EFFECT_CHAR[(byte >>> 4) & 0xf] ?? "·",
    magnitude: byte & 0xf,
  };
}

/**
 * The volume column byte after typing hex digit `nib` into its first
 * (`"hi"`) or second (`"lo"`) character. Returns `null` when the digit
 * means nothing there, so the caller leaves the cell and cursor alone.
 *
 * First character:
 *   0..4  set volume — the digit is the volume's high hex digit
 *   5     nothing (volume stops at 40)
 *   6..F  the effect kinds, as `VOL_EFFECT_CHAR` lists them
 * Second character: the low digit of the volume, or the effect's
 * magnitude. On an empty cell it starts a set-volume, so typing just
 * `9` there gives volume 09.
 *
 * The other character is kept — the low digit when the first is typed,
 * the kind when the second is — and a volume is clamped to 40.
 */
export function volumeColumnWithDigit(
  byte: number,
  which: "hi" | "lo",
  digit: number,
): number | null {
  const nib = digit & 0xf;
  const volume = volumeColumnSetValue(byte);
  // The cell's current second character, whatever kind it is.
  const low = volume !== null ? volume & 0xf : byte & 0xf;
  const setVolume = (value: number) =>
    XM_VOL_SET_BASE + Math.min(XM_VOL_MAX, value);

  if (which === "hi") {
    if (nib <= 0x4) return setVolume((nib << 4) | low);
    if (nib === 0x5) return null;
    return (nib << 4) | low;
  }
  // Second character.
  if (byte >= VOL_EFFECT_BASE) return (byte & 0xf0) | nib;
  return setVolume(((volume ?? 0) & 0xf0) | nib);
}

/** Standard XM note names — note number 1..96 = C-0..B-7. */
export const NOTE_NAMES: ReadonlyArray<string> = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
];

/** Returns the FT2 display string for a note. note=0 → "...", 97 → "==.". */
export function noteString(note: number): string {
  if (note === 0) return "...";
  if (note === 97) return "==.";
  if (note < 1 || note > 96) return "???";
  const idx = note - 1;
  const name = NOTE_NAMES[idx % 12]!;
  const octave = Math.floor(idx / 12);
  return `${name}${octave}`;
}
