// Why: physical-key piano mapping (one octave + 4 keys overlap into the
// next). Identical in PT and XM modes — the field gate decides which
// commit path the key reaches.
export const PIANO_KEYS: Readonly<Record<string, number>> = {
  a: 0, // C
  w: 1, // C#
  s: 2, // D
  e: 3, // D#
  d: 4, // E
  f: 5, // F
  t: 6, // F#
  g: 7, // G
  y: 8, // G#
  h: 9, // A
  u: 10, // A#
  j: 11, // B
  k: 12, // C +1 octave
  o: 13, // C# +1
  l: 14, // D +1
  p: 15, // D# +1
  ";": 16, // E +1
};

export const HEX_KEYS: Readonly<Record<string, number>> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  a: 10,
  b: 11,
  c: 12,
  d: 13,
  e: 14,
  f: 15,
};

// Why: digit-row quick-pick — 1..9 maps to 1..9, 0 maps to 10. Used by PT
// (sample) and XM (instrument) keybinds; the gate keys it to the right
// signal.
export const DIGIT_QUICK_PICK: Readonly<Record<string, number>> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "0": 10,
};

import { transport } from "./song";
import { settings } from "./settings";

/**
 * Gate for edit-time keybinds. Returns true when the user can mutate the
 * song: either playback is idle, or the Follow Playhead toggle is off
 * (meaning the user is intentionally decoupling the view from the
 * playhead and wants to edit live — `sync.ts` forwards every commit to
 * the engine via `replaceSong`, so playback keeps going).
 */
export function editsAllowed(): boolean {
  return transport() !== "playing" || !settings().followPlayback;
}

/**
 * The audition voice is monophonic: a newer piano key takes it over from
 * an older one. Releasing the OLDER key must then leave the newer note
 * alone — it used to stop the voice (and, on the first audition after
 * page load, cancel the newer note before the engine had even started
 * it) while the key that owned it was still held.
 */
let heldPianoKey: string | null = null;

/** Record `key` as the piano key that now owns the audition voice. */
export function pianoKeyDown(key: string): void {
  heldPianoKey = key;
}

/**
 * Whether releasing `key` should stop the audition. False only when a
 * different, newer key owns the voice; an untracked release still stops,
 * so nothing can be left droning.
 */
export function pianoKeyUp(key: string): boolean {
  if (heldPianoKey !== null && heldPianoKey !== key) return false;
  heldPianoKey = null;
  return true;
}
