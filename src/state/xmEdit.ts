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

/**
 * Run an instrument change and, when it actually moved to another
 * instrument, go back to its first sample — the sample index belongs to
 * the instrument it was picked on.
 *
 * This lives in the setters rather than in a component effect on
 * purpose: an effect also ran on mount, where it wiped a sample index a
 * session restore had just put back.
 */
function switchingInstrument(change: () => void): void {
  const before = instrument.sig();
  change();
  if (instrument.sig() !== before) sampleIndex.set(0);
}

export const currentXmOctave = octave.sig;
export const setCurrentXmOctave = octave.set;
export const currentXmInstrument = instrument.sig;
export const setCurrentXmInstrument = (n: number): void =>
  switchingInstrument(() => instrument.set(n));
export const currentXmSampleIndex = sampleIndex.sig;
export const setCurrentXmSampleIndex = sampleIndex.set;

export const xmOctaveUp = octave.inc;
export const xmOctaveDown = octave.dec;
export const selectXmInstrument = (n: number): void =>
  switchingInstrument(() => instrument.selectClamped(n));
export const nextXmInstrument = (): void => switchingInstrument(instrument.inc);
export const prevXmInstrument = (): void => switchingInstrument(instrument.dec);

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
