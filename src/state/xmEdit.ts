import { createSignal } from "solid-js";

import type { XmField } from "./cursorXm";
import type { XmNote } from "../core/xm/types";

export const XM_MIN_OCTAVE = 0;
export const XM_MAX_OCTAVE = 7;
export const XM_MIN_INSTRUMENT = 1;
export const XM_MAX_INSTRUMENT = 128;

export const [currentXmOctave, setCurrentXmOctave] = createSignal<number>(4);

export const [currentXmInstrument, setCurrentXmInstrument] =
  createSignal<number>(1);

export const [currentXmSampleIndex, setCurrentXmSampleIndex] =
  createSignal<number>(0);

export function xmOctaveUp(): void {
  setCurrentXmOctave((o) => Math.min(XM_MAX_OCTAVE, o + 1));
}

export function xmOctaveDown(): void {
  setCurrentXmOctave((o) => Math.max(XM_MIN_OCTAVE, o - 1));
}

export function selectXmInstrument(n: number): void {
  setCurrentXmInstrument(
    Math.max(XM_MIN_INSTRUMENT, Math.min(XM_MAX_INSTRUMENT, n)),
  );
}

export function nextXmInstrument(): void {
  setCurrentXmInstrument((s) => Math.min(XM_MAX_INSTRUMENT, s + 1));
}

export function prevXmInstrument(): void {
  setCurrentXmInstrument((s) => Math.max(XM_MIN_INSTRUMENT, s - 1));
}

// Why: clearing note also wipes instrument; clearing any volume/effect nibble
// wipes both nibbles (half-typed codes are meaningless). Inst hi/lo preserves
// the other nibble so partial entry survives.
export function clearXmFieldPatch(
  note: XmNote,
  field: XmField,
): Partial<XmNote> {
  switch (field) {
    case "note":
      return { note: 0, instrument: 0 };
    case "instHi":
      return { instrument: note.instrument & 0x0f };
    case "instLo":
      return { instrument: note.instrument & 0xf0 };
    case "volHi":
    case "volLo":
      return { volumeColumn: 0 };
    case "effectCmd":
    case "effectHi":
    case "effectLo":
      return { effect: 0, effectParam: 0 };
  }
}
