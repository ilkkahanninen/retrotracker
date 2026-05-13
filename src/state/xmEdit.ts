import type { XmField } from "./cursorXm";
import type { XmNote } from "../core/xm/types";
import { createRangedSignal } from "./editPrimitives";

export const XM_MIN_OCTAVE = 0;
export const XM_MAX_OCTAVE = 7;
export const XM_MIN_INSTRUMENT = 1;
export const XM_MAX_INSTRUMENT = 128;

const octave = createRangedSignal({
  min: XM_MIN_OCTAVE,
  max: XM_MAX_OCTAVE,
  initial: 4,
});
const instrument = createRangedSignal({
  min: XM_MIN_INSTRUMENT,
  max: XM_MAX_INSTRUMENT,
  initial: 1,
});
const sampleIndex = createRangedSignal({
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  initial: 0,
});

export const currentXmOctave = octave.sig;
export const setCurrentXmOctave = octave.set;
export const currentXmInstrument = instrument.sig;
export const setCurrentXmInstrument = instrument.set;
export const currentXmSampleIndex = sampleIndex.sig;
export const setCurrentXmSampleIndex = sampleIndex.set;

export const xmOctaveUp = octave.inc;
export const xmOctaveDown = octave.dec;
export const selectXmInstrument = instrument.selectClamped;
export const nextXmInstrument = instrument.inc;
export const prevXmInstrument = instrument.dec;

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
