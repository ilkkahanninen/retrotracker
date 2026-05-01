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

export const [currentOctave, setCurrentOctave] = createSignal<number>(2);
export const [currentSample, setCurrentSample] = createSignal<number>(1);

export function octaveUp(): void {
  setCurrentOctave((o) => Math.min(MAX_OCTAVE, o + 1));
}

export function octaveDown(): void {
  setCurrentOctave((o) => Math.max(MIN_OCTAVE, o - 1));
}

/**
 * Patch that clears the cursor's current field on a Note. Clearing the
 * note also wipes the sample — a sample number without a period plays
 * nothing on PT and is almost always a leftover from a since-deleted
 * note. Clearing the effect command also wipes the param — a param
 * without a command is a dangling number with no meaning. The hi/lo
 * nibble clears preserve the other nibble so partial entry survives.
 */
export function clearFieldPatch(note: Note, field: Field): Partial<Note> {
  switch (field) {
    case 'note':      return { period: 0, sample: 0 };
    case 'sampleHi':  return { sample: note.sample & 0x0f };
    case 'sampleLo':  return { sample: note.sample & 0xf0 };
    case 'effectCmd': return { effect: 0, effectParam: 0 };
    case 'effectHi':  return { effectParam: note.effectParam & 0x0f };
    case 'effectLo':  return { effectParam: note.effectParam & 0xf0 };
  }
}
