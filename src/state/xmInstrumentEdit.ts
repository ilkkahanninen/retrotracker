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
  clearXmInstrument as clearXmInstrumentMutation,
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
import { setCurrentXmSampleIndex } from "./xmEdit";
import {
  commitEditXm,
  commitEditXmWithWorkbenches,
  transport,
  xm2Song,
  type XmEditState,
} from "./song";
import { settings } from "./settings";
import { runXmPipeline } from "../core/audio/sampleWorkbench";
import {
  getXmWorkbench,
  withXmSampleRemoved,
  withXmWorkbenchCopied,
  withoutXmInstrumentWorkbenches,
  withoutXmWorkbench,
} from "./xmSampleWorkbench";
import { runContextForXmSample } from "./xmSampleEdit";

const XM_SAMPLE_NAME_MAX = 22;
const XM_MAX_SAMPLES_PER_INSTRUMENT = 16;

export type XmEnvelopeKind = "volume" | "panning";

/**
 * Commit a change to which sample bytes live in which `(instrument,
 * sample)` slot, together with the matching workbench-map fix-up, as one
 * undo entry. Every op that replaces / removes / copies sample data
 * outside the pipeline goes through here: a workbench left behind under
 * the slot's key would re-render its OLD source over the new audio on the
 * next chain edit.
 *
 * Same playback gate as `commitEditXm` (no-op while playing with Follow
 * on) — `commitEditXmWithWorkbenches` itself is ungated because the
 * pipeline editors are allowed mid-playback; these structural ops aren't.
 *
 * Returns whether anything was committed. Callers that follow up with
 * non-history UI changes (select the new instrument, clear the waveform
 * selection, …) must skip them on `false` — otherwise a gated or rejected
 * op still moves the UI as if it had happened.
 *
 * By default a transform that leaves the song untouched is treated as
 * rejected (out-of-range slot, cap reached, …) so it can't strand a
 * workbench-only change. Clear-style ops pass `allowWorkbenchOnly` — a
 * slot can be empty in the song yet still own a workbench worth dropping.
 */
export function commitXmSlotShape(
  transform: (state: XmEditState) => XmEditState,
  opts: { allowWorkbenchOnly?: boolean } = {},
): boolean {
  if (transport() === "playing" && settings().followPlayback) return false;
  let committed = false;
  commitEditXmWithWorkbenches((state) => {
    const next = transform(state);
    if (next.song === state.song && !opts.allowWorkbenchOnly) return state;
    committed =
      next.song !== state.song || next.xmWorkbenches !== state.xmWorkbenches;
    return next;
  });
  return committed;
}

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
  // Why: crossfade reads the loop bounds via RunContext at pipeline time —
  // a bare loop-field patch leaves the slot's audio glued to the old fade.
  // Re-run the chain through the new loop in the same commit so undo
  // reverts both halves atomically. Mirrors PT2's patchCurrentSample.
  const touchesLoop =
    "loopStart" in patch || "loopLength" in patch || "loopType" in patch;
  const wb = touchesLoop ? getXmWorkbench(slot1Based, sampleIndex) : undefined;
  const needsRerun = !!wb && wb.chain.some((e) => e.kind === "crossfade");
  if (!needsRerun || !wb) {
    commitEditXm((s) =>
      patchXmInstrumentSampleMutation(s, slot1Based, patch, sampleIndex),
    );
    return;
  }
  commitEditXmWithWorkbenches((state) => {
    const patched = patchXmInstrumentSampleMutation(
      state.song,
      slot1Based,
      patch,
      sampleIndex,
    );
    if (patched === state.song) return state;
    const patchedSample =
      patched.instruments[slot1Based - 1]?.samples[sampleIndex];
    if (!patchedSample) return { ...state, song: patched };
    const ctx = runContextForXmSample(patchedSample);
    // No loop after the patch → crossfade is a pass-through, nothing to re-run.
    if (!ctx) return { ...state, song: patched };
    const { data, bits } = runXmPipeline(wb, ctx);
    const updated: XmSample = { ...patchedSample, data, bits };
    return {
      ...state,
      song: setXmInstrumentSampleMutation(
        patched,
        slot1Based,
        updated,
        sampleIndex,
      ),
    };
  });
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
  // The slot's previous workbench described the bytes being replaced —
  // drop it so the pipeline lazily re-wraps the NEW sample.
  commitXmSlotShape((state) => ({
    song: setXmInstrumentSampleMutation(
      state.song,
      slot1Based,
      sample,
      sampleIndex,
    ),
    xmWorkbenches: withoutXmWorkbench(
      state.xmWorkbenches,
      slot1Based,
      sampleIndex,
    ),
  }));
}

/** Append a fresh empty sample to the instrument's sample list (cap 16). */
export function addXmSample(slot1Based: number): void {
  commitXmSlotShape((state) => {
    const song = addXmInstrumentSampleMutation(state.song, slot1Based);
    const newIndex =
      (song.instruments[slot1Based - 1]?.samples.length ?? 1) - 1;
    // Defensive: an orphan key at the new index (e.g. from a project
    // saved before removals re-keyed the map) must not attach itself to
    // the fresh empty sample.
    return {
      song,
      xmWorkbenches: withoutXmWorkbench(
        state.xmWorkbenches,
        slot1Based,
        newIndex,
      ),
    };
  });
}

/** Remove the sample at `sampleIndex`. KeyMap entries re-anchor to 0.
 *  Workbenches of the later samples shift down with them. */
export function removeXmSample(slot1Based: number, sampleIndex: number): void {
  commitXmSlotShape((state) => ({
    song: removeXmInstrumentSampleMutation(state.song, slot1Based, sampleIndex),
    xmWorkbenches: withXmSampleRemoved(
      state.xmWorkbenches,
      slot1Based,
      sampleIndex,
    ),
  }));
}

/** Replace the instrument's 96-byte note → sample-index map. */
export function setXmKeyMap(slot1Based: number, keyMap: Uint8Array): void {
  commitEditXm((s) => setXmInstrumentKeyMapMutation(s, slot1Based, keyMap));
}

/**
 * Duplicate the sample at `sampleIndex` into the next free slot on the
 * same instrument (capped at 16). Appends " copy" to the name (trimmed
 * to the 22-char XM limit) and switches the active sample to the new
 * one. No-op when the cap is reached.
 */
export function duplicateXmSample(
  slot1Based: number,
  sampleIndex: number,
): void {
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[slot1Based - 1];
  if (!inst) return;
  if (inst.samples.length >= XM_MAX_SAMPLES_PER_INSTRUMENT) return;
  const src = inst.samples[sampleIndex];
  if (!src) return;
  const copyName =
    src.name.length > 0
      ? `${src.name} copy`.slice(0, XM_SAMPLE_NAME_MAX)
      : "copy";
  const copyData: Int8Array | Int16Array =
    src.bits === 8
      ? new Int8Array(src.data as Int8Array)
      : new Int16Array(src.data as Int16Array);
  const dup: XmSample = { ...src, name: copyName, data: copyData };
  const newIndex = inst.samples.length;
  // The copy carries the source's workbench (same bytes, same pipeline),
  // replacing whatever key might linger at the new index.
  const committed = commitXmSlotShape((state) => ({
    song: setXmInstrumentSampleMutation(state.song, slot1Based, dup, newIndex),
    xmWorkbenches: withXmWorkbenchCopied(
      state.xmWorkbenches,
      slot1Based,
      sampleIndex,
      slot1Based,
      newIndex,
    ),
  }));
  // Gated (Play + Follow): nothing was added, so don't select it.
  if (!committed) return;
  setCurrentXmSampleIndex(newIndex);
}

/**
 * Wipe the entire instrument at the given slot — samples, envelopes,
 * autovibrato, keymap, name. The slot reads as empty afterwards. Used
 * by the "Clear instrument" header action.
 */
export function clearXmInstrument(slot1Based: number): boolean {
  // Song + every workbench keyed on the slot go in one undo entry, so a
  // gated call (Play + Follow) changes neither and undo restores both.
  return commitXmSlotShape(
    (state) => ({
      song: clearXmInstrumentMutation(state.song, slot1Based),
      xmWorkbenches: withoutXmInstrumentWorkbenches(
        state.xmWorkbenches,
        slot1Based,
      ),
    }),
    { allowWorkbenchOnly: true },
  );
}

/**
 * Reset the sample's data to an empty buffer of the same bit depth and
 * drop loop fields. Keeps the rest of the metadata (volume, panning,
 * relative note, finetune, name) so the user can repopulate the slot
 * without re-setting their tuning.
 */
export function clearXmSampleData(
  slot1Based: number,
  sampleIndex: number,
): boolean {
  const s = xm2Song();
  if (!s) return false;
  const inst = s.instruments[slot1Based - 1];
  if (!inst) return false;
  const src = inst.samples[sampleIndex];
  if (!src) return false;
  const emptyData: Int8Array | Int16Array =
    src.bits === 8 ? new Int8Array(0) : new Int16Array(0);
  const cleared: XmSample = {
    ...src,
    data: emptyData,
    loopStart: 0,
    loopLength: 0,
    loopType: "none",
  };
  // Drop the workbench in the same commit: left behind, the next chain
  // edit would re-render the cleared audio straight back into the slot.
  return commitXmSlotShape(
    (state) => ({
      song: setXmInstrumentSampleMutation(
        state.song,
        slot1Based,
        cleared,
        sampleIndex,
      ),
      xmWorkbenches: withoutXmWorkbench(
        state.xmWorkbenches,
        slot1Based,
        sampleIndex,
      ),
    }),
    { allowWorkbenchOnly: true },
  );
}
