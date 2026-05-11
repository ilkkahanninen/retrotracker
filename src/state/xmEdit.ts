/**
 * FT2-mode edit state — parallel to `state/edit.ts` (PT2). XM has eight
 * octaves (C-0..B-7) and 128 instrument slots, so the per-format ranges
 * differ from PT's three octaves and 31 samples. We keep two separate
 * signals (rather than reusing PT's) so the user's last-active position
 * in either mode survives a project swap.
 */

import { createSignal } from "solid-js";

import type { XmField } from "./cursorXm";
import type { XmNote } from "../core/xm/types";

export const XM_MIN_OCTAVE = 0;
export const XM_MAX_OCTAVE = 7;
export const XM_MIN_INSTRUMENT = 1;
export const XM_MAX_INSTRUMENT = 128;

/**
 * Octave used by piano-key entry in FT2 mode. XM note numbers are
 * 1-based 1..96 covering C-0..B-7; this signal selects the octave the
 * piano row maps to. Defaults to 4 — a middle register that works for
 * most material without an immediate octave hop.
 */
export const [currentXmOctave, setCurrentXmOctave] = createSignal<number>(4);

/**
 * Active instrument written into a cell on note entry. Defaults to 1.
 */
export const [currentXmInstrument, setCurrentXmInstrument] =
  createSignal<number>(1);

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

/**
 * Patch that clears the cursor's current field on an XM cell. Mirrors
 * PT's `clearFieldPatch` policy:
 *   - clearing the note also wipes the instrument (an instrument with no
 *     note is a leftover from a deleted note);
 *   - clearing any volume nibble wipes both — half a volume code is
 *     meaningless;
 *   - clearing any effect nibble wipes the whole effect (cmd + param) —
 *     same reason as PT.
 * Instrument hi/lo clears keep the other nibble so partial entry survives.
 */
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
