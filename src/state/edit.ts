import type { Note } from "../core/mod/types";
import type { Field } from "./cursor";
import { createRangedSignal } from "./editPrimitives";

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 3;
export const MIN_SAMPLE = 1;
export const MAX_SAMPLE = 31;

// Why: backspace / insert blank-line always step by 1 regardless of editStep —
// they move relative to structural inserts/deletes, not entered content.
export const MIN_EDIT_STEP = 0;
export const MAX_EDIT_STEP = 16;

const octave = createRangedSignal({
  min: MIN_OCTAVE,
  max: MAX_OCTAVE,
  initial: 2,
});
const sample = createRangedSignal({
  min: MIN_SAMPLE,
  max: MAX_SAMPLE,
  initial: 1,
});
const step = createRangedSignal({
  min: MIN_EDIT_STEP,
  max: MAX_EDIT_STEP,
  initial: 1,
});

export const currentOctave = octave.sig;
export const setCurrentOctave = octave.set;
export const currentSample = sample.sig;
export const setCurrentSample = sample.set;
export const editStep = step.sig;
export const setEditStep = step.set;

export const octaveUp = octave.inc;
export const octaveDown = octave.dec;
export const selectSample = sample.selectClamped;
export const nextSample = sample.inc;
export const prevSample = sample.dec;
export const incEditStep = step.inc;
export const decEditStep = step.dec;

export function resetEditStep(): void {
  step.set(1);
}

// Why: clearing note also wipes sample (orphaned sample numbers play nothing
// on PT); clearing any effect nibble wipes cmd+param (half-typed effects
// require triple-tap to fully erase). Sample hi/lo preserves the other nibble.
export function clearFieldPatch(note: Note, field: Field): Partial<Note> {
  switch (field) {
    case "note":
      return { period: 0, sample: 0 };
    case "sampleHi":
      return { sample: note.sample & 0x0f };
    case "sampleLo":
      return { sample: note.sample & 0xf0 };
    case "effectCmd":
    case "effectHi":
    case "effectLo":
      return { effect: 0, effectParam: 0 };
  }
}
