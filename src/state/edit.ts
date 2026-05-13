import { createSignal } from "solid-js";
import type { Note } from "../core/mod/types";
import type { Field } from "./cursor";

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 3;
export const MIN_SAMPLE = 1;
export const MAX_SAMPLE = 31;

// Why: backspace / insert blank-line always step by 1 regardless of editStep —
// they move relative to structural inserts/deletes, not entered content.
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

export function resetEditStep(): void {
  setEditStep(1);
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
