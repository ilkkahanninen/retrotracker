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
 * Volume-column high-nibble label table. The XM volume column packs
 * (kind, magnitude) into one byte. The grid renders both halves as one
 * char each for a uniform 2-char cell width. The kind char is:
 *   - the hex digit for the set-volume range (high nibble 1..5 means
 *     "set volume hi*16 + lo", so the digit IS the high nibble);
 *   - a letter for the slide / vibrato / panning / portamento ops
 *     (mirroring OpenMPT-style display, since FT2's own display goes
 *     out of sync with our font metrics).
 */
const VOL_KIND_CHAR: ReadonlyArray<string> = [
  "·", // 0x0 — empty (filtered out by the null return below)
  "1", // 0x10..0x1F — set vol (low nibble = magnitude)
  "2", // 0x20..0x2F — set vol
  "3", // 0x30..0x3F — set vol
  "4", // 0x40..0x4F — set vol
  "5", // 0x50         — set vol (XM caps at 0x50; 0x51..0x5F unused)
  "-", // 0x6 — vol slide down
  "+", // 0x7 — vol slide up
  "D", // 0x8 — fine vol slide down
  "U", // 0x9 — fine vol slide up
  "S", // 0xA — vibrato speed
  "V", // 0xB — vibrato w/ depth
  "P", // 0xC — set panning
  "L", // 0xD — pan slide left
  "R", // 0xE — pan slide right
  "M", // 0xF — tone portamento
];

/**
 * Decode the volume column byte into (kind char, magnitude nibble) where
 * both halves render as one character so the grid cell stays exactly
 * two characters wide. Returns `null` for an empty cell (byte === 0).
 */
export function decodeVolumeColumn(
  byte: number,
): { kind: string; magnitude: number } | null {
  if (byte === 0) return null;
  const hi = (byte >>> 4) & 0xf;
  const lo = byte & 0xf;
  return { kind: VOL_KIND_CHAR[hi] ?? "·", magnitude: lo };
}

/** Standard XM note names — note number 1..96 = C-0..B-7. */
const NOTE_NAMES: ReadonlyArray<string> = [
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
