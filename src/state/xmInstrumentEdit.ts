/**
 * FT2 instrument-level edit actions. Phase 4 covers the full instrument
 * editor surface: renames, envelope point / flag patches, autovibrato,
 * fadeout, sample-meta tweaks (volume / finetune / loop / etc.), and
 * outright sample replacement (used by WAV drop-import).
 */

import type { XmEnvelope, XmEnvelopePoint, XmSample } from "../core/xm/types";
import {
  addXmEnvelopePoint as addXmEnvelopePointMutation,
  addXmInstrumentSample as addXmInstrumentSampleMutation,
  patchXmInstrumentAutoVibrato as patchXmInstrumentAutoVibratoMutation,
  patchXmInstrumentEnvelope as patchXmInstrumentEnvelopeMutation,
  patchXmInstrumentSample as patchXmInstrumentSampleMutation,
  removeXmEnvelopePoint as removeXmEnvelopePointMutation,
  removeXmInstrumentSample as removeXmInstrumentSampleMutation,
  renameXmInstrument as renameXmInstrumentMutation,
  setXmEnvelopePoint as setXmEnvelopePointMutation,
  setXmInstrumentFadeout as setXmInstrumentFadeoutMutation,
  setXmInstrumentKeyMap as setXmInstrumentKeyMapMutation,
  setXmInstrumentSample as setXmInstrumentSampleMutation,
} from "../core/xm/mutations";
import { commitEditXm } from "./song";

export type XmEnvelopeKind = "volume" | "panning";

/** 1-based slot index — the instrument list's inline rename can target any slot. */
export function renameXmInstrument(slot1Based: number, name: string): void {
  commitEditXm((s) => renameXmInstrumentMutation(s, slot1Based, name));
}

export function patchXmInstrumentEnvelope(
  slot1Based: number,
  kind: XmEnvelopeKind,
  patch: Partial<XmEnvelope>,
): void {
  commitEditXm((s) =>
    patchXmInstrumentEnvelopeMutation(s, slot1Based, kind, patch),
  );
}

export function setXmEnvelopePoint(
  slot1Based: number,
  kind: XmEnvelopeKind,
  pointIndex: number,
  point: XmEnvelopePoint,
): void {
  commitEditXm((s) =>
    setXmEnvelopePointMutation(s, slot1Based, kind, pointIndex, point),
  );
}

export function addXmEnvelopePoint(
  slot1Based: number,
  kind: XmEnvelopeKind,
  point: XmEnvelopePoint,
): void {
  commitEditXm((s) => addXmEnvelopePointMutation(s, slot1Based, kind, point));
}

export function removeXmEnvelopePoint(
  slot1Based: number,
  kind: XmEnvelopeKind,
  pointIndex: number,
): void {
  commitEditXm((s) =>
    removeXmEnvelopePointMutation(s, slot1Based, kind, pointIndex),
  );
}

export function patchXmAutoVibrato(
  slot1Based: number,
  patch: Parameters<typeof patchXmInstrumentAutoVibratoMutation>[2],
): void {
  commitEditXm((s) =>
    patchXmInstrumentAutoVibratoMutation(s, slot1Based, patch),
  );
}

export function setXmFadeout(slot1Based: number, fadeout: number): void {
  commitEditXm((s) => setXmInstrumentFadeoutMutation(s, slot1Based, fadeout));
}

export function patchXmSample(
  slot1Based: number,
  patch: Parameters<typeof patchXmInstrumentSampleMutation>[2],
  sampleIndex = 0,
): void {
  commitEditXm((s) =>
    patchXmInstrumentSampleMutation(s, slot1Based, patch, sampleIndex),
  );
}

/**
 * Replace the inner sample at `sampleIndex` (used by WAV drop-import).
 * Brings the new data + bit-depth along; envelope / vibrato / fadeout
 * stay put so the user can swap waveforms without losing instrument-level
 * edits. Index past the current length appends a new sample slot.
 */
export function setXmSample(
  slot1Based: number,
  sample: XmSample,
  sampleIndex = 0,
): void {
  commitEditXm((s) =>
    setXmInstrumentSampleMutation(s, slot1Based, sample, sampleIndex),
  );
}

/** Append a fresh empty sample to the instrument's sample list (cap 16). */
export function addXmSample(slot1Based: number): void {
  commitEditXm((s) => addXmInstrumentSampleMutation(s, slot1Based));
}

/** Remove the sample at `sampleIndex`. KeyMap entries re-anchor to 0. */
export function removeXmSample(slot1Based: number, sampleIndex: number): void {
  commitEditXm((s) =>
    removeXmInstrumentSampleMutation(s, slot1Based, sampleIndex),
  );
}

/** Replace the instrument's 96-byte note → sample-index map. */
export function setXmKeyMap(slot1Based: number, keyMap: Uint8Array): void {
  commitEditXm((s) => setXmInstrumentKeyMapMutation(s, slot1Based, keyMap));
}
