import { createSignal } from 'solid-js';
import type { Note } from '../core/mod/types';
import type { Field } from './cursor';

/**
 * Editing state — knobs that influence cell entry.
 *
 *   - `currentOctave` (1..3) shifts the piano-key mapping. ProTracker has
 *     three octaves (C-1..B-3), so 2 is a sensible default.
 *   - `currentSample` (1..31) is what gets stamped into the cell when the
 *     user types a note. We default to 1; a future sample-list selector
 *     will drive this.
 */

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 3;
export const MIN_SAMPLE = 1;
export const MAX_SAMPLE = 31;

/**
 * FT2-style "edit step": the number of rows the cursor advances after a
 * note/sample/effect entry. 0 keeps the cursor on the same row (useful for
 * stamping chords or overwriting); 16 jumps a 4/4 bar. Defaults to 1.
 *
 * Backspace / Insert blank-line are STRUCTURAL edits and always move by 1
 * regardless of this setting — they're moving the cursor relative to
 * inserted/deleted content, not advancing past entered content.
 */
export const MIN_EDIT_STEP = 0;
export const MAX_EDIT_STEP = 16;

export const [currentOctave, setCurrentOctave] = createSignal<number>(2);
export const [currentSample, setCurrentSample] = createSignal<number>(1);
export const [editStep, setEditStep] = createSignal<number>(1);

export function octaveUp(): void {
  setCurrentOctave((o) => Math.min(MAX_OCTAVE, o + 1));
}

export function octaveDown(): void {
  setCurrentOctave((o) => Math.max(MIN_OCTAVE, o - 1));
}

/** Set the active sample, clamped to ProTracker's 1..31 range. */
export function selectSample(n: number): void {
  setCurrentSample(Math.max(MIN_SAMPLE, Math.min(MAX_SAMPLE, n)));
}

export function nextSample(): void {
  setCurrentSample((s) => Math.min(MAX_SAMPLE, s + 1));
}

export function prevSample(): void {
  setCurrentSample((s) => Math.max(MIN_SAMPLE, s - 1));
}

export function incEditStep(): void {
  setEditStep((s) => Math.min(MAX_EDIT_STEP, s + 1));
}

export function decEditStep(): void {
  setEditStep((s) => Math.max(MIN_EDIT_STEP, s - 1));
}

/** Snap the edit step back to its default of 1. */
export function resetEditStep(): void {
  setEditStep(1);
}

/**
 * Patch that clears the cursor's current field on a Note. Clearing the
 * note also wipes the sample — a sample number without a period plays
 * nothing on PT and is almost always a leftover from a since-deleted
 * note. Clearing ANY of the effect nibbles wipes the whole effect (cmd
 * + param): a param without a command is meaningless, and tap-deleting
 * just one nibble leaves a half-typed effect that the user has to
 * triple-tap to fully erase — `.` from any effect column clears all
 * three at once. Sample hi/lo nibble clears still preserve the other
 * nibble so partial entry survives there.
 */
export function clearFieldPatch(note: Note, field: Field): Partial<Note> {
  switch (field) {
    case 'note':      return { period: 0, sample: 0 };
    case 'sampleHi':  return { sample: note.sample & 0x0f };
    case 'sampleLo':  return { sample: note.sample & 0xf0 };
    case 'effectCmd':
    case 'effectHi':
    case 'effectLo':
      return { effect: 0, effectParam: 0 };
  }
}
