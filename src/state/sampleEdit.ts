import type { Sample, Song } from "../core/mod/types";
import {
  clearSample,
  replaceSampleData,
  setSample,
} from "../core/mod/mutations";
import { cropSample, cutSample } from "../core/mod/sampleSelection";
import { bounceSelection } from "../core/audio/bounce";
import type { ChiptuneParams } from "../core/audio/chiptune";
import {
  ENVELOPE_MIN_POINTS,
  PARAM_AXES,
  defaultEffect,
  emptySamplerWorkbench,
  materializeSource,
  runChain,
  runPipeline,
  sourceDisplayName,
  sourceWantsFullLoop,
  workbenchFromChiptune,
  workbenchFromInt8,
  workbenchFromWav,
  workbenchFromWavData,
  workbenchToAlt,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
  type MonoMix,
  type ResampleMode,
  type RunContext,
  type SampleWorkbench,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import type { SampleSelection } from "../components/SampleView";
import { commitEdit, commitEditWithWorkbenches, song, transport } from "./song";
import { currentSample, selectSample } from "./edit";
import {
  getWorkbench,
  setWorkbench,
  withWorkbench,
  withoutWorkbench,
} from "./sampleWorkbench";
import { clearStashedLoop } from "./loopStash";
import {
  clearImportedStash,
  getImportedStash,
  stashImportedSample,
} from "./importedStash";
import { sampleClipboard, setSampleClipboard } from "./sampleClipboard";
import { sampleSelection } from "./sampleSelection";
import {
  defaultParamForKind,
  setSelectedEffectIndex,
  setSelectedEffectParam,
} from "./selectedEffect";
import { selection } from "./selection";
import { activePreview } from "./preview";
import { livePreviewSwap } from "./playback";
import { setError } from "./session";

/**
 * Sample-pipeline editing. Entry points key off `currentSample()` (the
 * 1-based slot the user has selected) and route through
 * `commitEditWithWorkbenches` so the song mutation and the workbench-map
 * update share a single undo entry. Allowed mid-playback — the live
 * worklet hot-swaps slot data via the sync forwarders in `state/sync.ts`.
 */

/** PT no-loop sentinel: loopLengthWords === 1 (a single word, two bytes). */
export const NO_LOOP = { loopStartWords: 0, loopLengthWords: 1 };

/** Lowest empty slot (`lengthWords === 0`) strictly after `from`. */
export function nextFreeSlot(s: Song | null, from: number): number | null {
  if (!s) return null;
  for (let i = from + 1; i < s.samples.length; i++) {
    if (s.samples[i]!.lengthWords === 0) return i;
  }
  return null;
}

/**
 * Run the workbench's pipeline and write the resulting int8 into `slot`.
 *
 * Volume / finetune / name / loop policy:
 *   - First write (empty slot): adopt source name, full volume, no loop.
 *   - Re-run (pipeline edits on a populated slot): preserve those fields.
 *     Otherwise dragging a gain slider would silently clobber the volume
 *     the user dialed in, and any loop they configured on the waveform.
 *   - Chiptune sources always force a full-sample loop. The synth output
 *     is a single cycle that's only musically useful looped, and the UI
 *     hides the Loop toggle.
 *
 * `loopOverride` is the explicit-pin escape hatch — highest priority,
 * beats both the chiptune full-loop rule and the preserve-old fallback.
 */
export function writeWorkbenchToSongPure(
  s: Song,
  slot: number,
  wb: SampleWorkbench,
  loopOverride?: { loopStartWords: number; loopLengthWords: number },
): Song {
  const old = s.samples[slot];
  // Loop-aware effects (currently just crossfade) re-scale these into
  // their own input frame space, so a `crop → crossfade` chain places
  // the fade inside the cropped audio rather than overshooting and
  // clamping. See `RunContext` doc.
  const ctx = (() => {
    if (!old || old.loopLengthWords <= 1 || old.data.length <= 0) return null;
    return {
      loopStartByte: old.loopStartWords * 2,
      loopEndByte: (old.loopStartWords + old.loopLengthWords) * 2,
      int8Length: old.data.length,
    };
  })();
  const data = runPipeline(wb, ctx);
  const isFirstWrite = !old || old.lengthWords === 0;
  const fullLoop =
    sourceWantsFullLoop(wb.source) && data.length >= 2
      ? { loopStartWords: 0, loopLengthWords: data.length >> 1 }
      : null;
  // Explicit override wins; otherwise chiptune's full-loop wins; otherwise
  // we fall through to first-write defaults (no loop) or preserve / scale old.
  const loopFields = loopOverride ?? fullLoop;
  // Length change + existing loop → scale the loop endpoints by the new
  // length ratio so the user keeps the same proportional region. Without
  // this, switching target note slid the loop relative to the audio.
  //
  // Compare against the POST-pad length: `replaceSampleData` rounds odd
  // payloads up to even, so an unpadded 4403-byte run lands on the same
  // lengthWords as a previously-stored 4404. Without the padding match,
  // every loop-drag re-run on an odd-length output triggered scaledLoop
  // and shaved one word off `loopLengthWords` per mousemove — the
  // "end point wanders left" bug.
  const scaledLoop = (() => {
    if (loopFields) return null;
    if (!old || old.loopLengthWords <= 1) return null;
    if (old.data.length <= 0) return null;
    const newPaddedLen = data.length + (data.length & 1);
    if (newPaddedLen === old.data.length) return null;
    const ratio = newPaddedLen / old.data.length;
    const oldEndBytes = (old.loopStartWords + old.loopLengthWords) * 2;
    const newStartBytes = Math.round(old.loopStartWords * 2 * ratio);
    const newEndBytes = Math.round(oldEndBytes * ratio);
    const newLenBytes = Math.max(4, newEndBytes - newStartBytes);
    // Word-align: PT loop fields count 16-bit words. `>> 1` floors to keep
    // the loop strictly inside the resampled data; `replaceSampleData`
    // also clamps, but landing in bounds first preserves loop *intent*.
    return {
      loopStartWords: Math.max(0, newStartBytes >> 1),
      loopLengthWords: Math.max(2, newLenBytes >> 1),
    };
  })();
  const meta: Parameters<typeof replaceSampleData>[3] = isFirstWrite
    ? {
        volume: 64,
        finetune: 0,
        name: sourceDisplayName(wb.source).slice(0, 22),
        ...(loopFields ?? {}),
      }
    : {
        volume: old.volume,
        finetune: old.finetune,
        name: old.name,
        ...(loopFields ??
          scaledLoop ?? {
            loopStartWords: old.loopStartWords,
            loopLengthWords: old.loopLengthWords,
          }),
      };
  return replaceSampleData(s, slot, data, meta);
}

function runContextForSlot(slot: number): RunContext | null {
  const sample = song()?.samples[slot];
  if (!sample || sample.loopLengthWords <= 1 || sample.data.length <= 0)
    return null;
  return {
    loopStartByte: sample.loopStartWords * 2,
    loopEndByte: (sample.loopStartWords + sample.loopLengthWords) * 2,
    int8Length: sample.data.length,
  };
}

/**
 * Map an int8-byte selection into the frame-range a NEW effect would
 * receive as input. The new effect runs on the chain's OUTPUT (post-
 * effects, pre-transformer), so scale the byte positions against the
 * chain output length, not the source.
 */
function selectionToChainFrames(
  wb: SampleWorkbench,
  startByte: number,
  endByte: number,
  int8Len: number,
): { startFrame: number; endFrame: number } | null {
  const chainOut = runChain(materializeSource(wb.source), wb.chain);
  const chainLen = chainOut.channels[0]?.length ?? 0;
  if (chainLen === 0 || int8Len === 0) return null;
  const startFrame = Math.max(
    0,
    Math.min(chainLen, Math.round((startByte * chainLen) / int8Len)),
  );
  const endFrame = Math.max(
    startFrame,
    Math.min(chainLen, Math.round((endByte * chainLen) / int8Len)),
  );
  if (endFrame - startFrame < 1) return null;
  return { startFrame, endFrame };
}

export function updateCurrentWorkbench(
  next: SampleWorkbench,
  loopOverride?: { loopStartWords: number; loopLengthWords: number },
): void {
  const slot = currentSample() - 1;
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: writeWorkbenchToSongPure(state.song, slot, next, loopOverride),
    workbenches: withWorkbench(state.workbenches, slot, next),
  }));
  // Centralised live-preview swap — covers every workbench-driven edit
  // so individual handlers don't have to remember to call it.
  const ap = activePreview();
  if (ap && ap.slot === slot) {
    const updatedSample = song()?.samples[slot];
    if (updatedSample) livePreviewSwap(slot, updatedSample, ap.period);
  }
}

export function patchCurrentSample(
  patch: Parameters<typeof setSample>[2],
): void {
  const slot = currentSample() - 1;
  // Loop-aware chain effects (currently just `crossfade`) bake the loop
  // boundary into the int8 at pipeline time. A bare loop-field edit
  // only mutates metadata, so audio stays glued to the previous loop
  // until the next pipeline run. Re-run here in the same commit so undo
  // reverts both halves atomically.
  const touchesLoop = "loopStartWords" in patch || "loopLengthWords" in patch;
  const wb = touchesLoop ? getWorkbench(slot) : undefined;
  const needsRerun = !!wb && wb.chain.some((e) => e.kind === "crossfade");
  commitEditWithWorkbenches((state) => {
    const next = setSample(state.song, slot, patch);
    if (next === state.song) return state;
    const finalSong =
      needsRerun && wb ? writeWorkbenchToSongPure(next, slot, wb) : next;
    return { ...state, song: finalSong };
  });
}

/** 1-based slot index — the sample list's inline rename can target any slot. */
export function renameSample(slot1Based: number, name: string): void {
  commitEditWithWorkbenches((state) => {
    const next = setSample(state.song, slot1Based - 1, { name });
    return next === state.song ? state : { ...state, song: next };
  });
}

export function clearCurrentSample(): void {
  const slot = currentSample() - 1;
  // Loop-stash is session-only and not part of the history snapshot. A
  // stale entry can't desync (worst case the user re-enables loop and
  // gets the whole-sample default), so just drop it eagerly. The
  // imported-sample side-stash describes bytes that no longer exist on
  // this slot — drop it for the same reason.
  clearStashedLoop(slot);
  clearImportedStash(slot);
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: clearSample(state.song, slot),
    workbenches: withoutWorkbench(state.workbenches, slot),
  }));
}

export function duplicateCurrentSample(): void {
  const s = song();
  if (!s) return;
  const slot = currentSample() - 1;
  const sample = s.samples[slot];
  if (!sample || sample.lengthWords === 0) return;
  const target = nextFreeSlot(s, slot);
  if (target === null) return;

  commitEditWithWorkbenches((state) => {
    const samples: Sample[] = [...state.song.samples];
    // The Int8Array `data` is shared by reference — the song treats it
    // as immutable, so this avoids cloning multi-KB buffers.
    samples[target] = { ...samples[slot]! };
    const newSong = { ...state.song, samples };
    const wb = state.workbenches.get(slot);
    // Shallow-clone every workbench level so future edits on slot N
    // can't mutate slot M through a shared chain / pt / alt reference.
    const newWorkbenches = wb
      ? withWorkbench(state.workbenches, target, {
          source: wb.source,
          chain: [...wb.chain],
          pt: { ...wb.pt },
          alt: wb.alt
            ? {
                source: wb.alt.source,
                chain: [...wb.alt.chain],
                pt: { ...wb.alt.pt },
                loop: wb.alt.loop ? { ...wb.alt.loop } : null,
              }
            : null,
        })
      : state.workbenches;
    return { ...state, song: newSong, workbenches: newWorkbenches };
  });
  selectSample(target + 1);
}

/**
 * Workbench path: append a Crop/Cut effect to the chain (non-destructive,
 * user can drop the effect to undo). No-workbench path (samples loaded
 * from a .mod have no source to preserve): direct int8 mutation.
 */
function applySelectionEdit(
  kind: "crop" | "cut",
  startByte: number,
  endByte: number,
): void {
  const slot = currentSample() - 1;
  const s = song()?.samples[slot];
  if (!s) return;
  const wb = getWorkbench(slot);
  if (wb) {
    const frames = selectionToChainFrames(
      wb,
      startByte,
      endByte,
      s.data.byteLength,
    );
    if (!frames) return;
    const effect: EffectNode = { kind, params: frames };
    updateCurrentWorkbench({ ...wb, chain: [...wb.chain, effect] });
    return;
  }
  const transform = kind === "crop" ? cropSample : cutSample;
  const result = transform(s, startByte, endByte);
  if (!result) return;
  commitEdit((cur) =>
    replaceSampleData(cur, slot, result.data, {
      name: s.name,
      volume: s.volume,
      finetune: s.finetune,
      loopStartWords: result.loopStartWords,
      loopLengthWords: result.loopLengthWords,
    }),
  );
}

export const cropCurrentSampleToSelection = (
  start: number,
  end: number,
): void => applySelectionEdit("crop", start, end);
export const cutCurrentSampleSelection = (start: number, end: number): void =>
  applySelectionEdit("cut", start, end);

/**
 * Resolve the byte range an end-user clipboard op (Copy / Cut) should
 * act on. Selection wins; otherwise fall back to the whole sample.
 * Empty slot → null (caller should no-op).
 *
 * The "whole sample if no selection" fallback is the user's chosen
 * policy — diverges from the pattern clipboard (which requires a
 * selection) so Cmd+C with nothing selected still does the obvious
 * thing in the sample view.
 */
export function effectiveSampleRange(): {
  start: number;
  end: number;
} | null {
  const slot = currentSample() - 1;
  const s = song()?.samples[slot];
  if (!s || s.data.byteLength < 1) return null;
  const sel = sampleSelection();
  if (sel && sel.end - sel.start >= 1) {
    const start = Math.max(0, Math.min(s.data.byteLength, sel.start));
    const end = Math.max(start, Math.min(s.data.byteLength, sel.end));
    if (end - start < 1) return null;
    return { start, end };
  }
  return { start: 0, end: s.data.byteLength };
}

/**
 * Slice the active slot's int8 bytes onto the sample clipboard. No-op
 * when the slot is empty. Bytes are copied (not referenced) so a later
 * cut / pipeline edit doesn't mutate the clipboard slice.
 */
export function copySampleRange(start: number, end: number): void {
  const slot = currentSample() - 1;
  const s = song()?.samples[slot];
  if (!s || s.data.byteLength < 1) return;
  const lo = Math.max(0, Math.min(s.data.byteLength, start));
  const hi = Math.max(lo, Math.min(s.data.byteLength, end));
  if (hi - lo < 1) return;
  // `slice` returns a fresh Int8Array — independent of the slot's data
  // ref so undo of a follow-up cut leaves the clipboard intact.
  setSampleClipboard(s.data.slice(lo, hi));
}

/**
 * Cut: copy the bytes, then route through the existing
 * `cutCurrentSampleSelection` so the workbench / no-workbench paths
 * (chain-effect append vs. direct int8 mutation) stay shared. The
 * clipboard write fires *before* the cut so that an undo of the cut
 * still leaves the bytes on the clipboard for paste.
 */
export function cutSampleRange(start: number, end: number): void {
  copySampleRange(start, end);
  cutCurrentSampleSelection(start, end);
}

/**
 * Replace the current slot's data with the clipboard bytes. Mirrors
 * `loadWavIntoCurrentSample` (which is "load WAV file"); paste is
 * "load WAV from in-memory int8" — same alt-stash preservation, same
 * NO_LOOP override, same `commitEditWithWorkbenches` snapshot. No-op
 * when the clipboard is empty.
 */
export function pasteSampleFromClipboard(): void {
  const data = sampleClipboard();
  if (!data || data.byteLength < 1) return;
  const slot = currentSample() - 1;
  let wb = workbenchFromInt8(data, "Pasted sample");
  // Pasting clobbers whatever int8 was at the slot — the imported
  // side-stash is no longer the canonical "previous state" for the
  // slot, so drop it (same policy as `loadWavIntoCurrentSample`).
  clearImportedStash(slot);
  // Preserve any chiptune workbench currently at the slot as the alt
  // so the user can toggle back to it. If the slot already had a
  // sampler with a chiptune in alt, carry that alt through too.
  const existing = getWorkbench(slot);
  if (existing) {
    if (existing.source.kind === "chiptune") {
      wb = { ...wb, alt: workbenchToAlt(existing) };
    } else if (existing.alt) {
      wb = { ...wb, alt: existing.alt };
    }
  }
  const wbToCommit = wb;
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: writeWorkbenchToSongPure(state.song, slot, wbToCommit, NO_LOOP),
    workbenches: withWorkbench(state.workbenches, slot, wbToCommit),
  }));
}

/**
 * Render the pattern selection through a CleanMixer (no Paula) into the
 * next free sample slot. Selection survives so the user can follow up
 * with Cut / Delete to clear the bounced rows.
 */
export function bounceSelectionToSample(): void {
  const s = song();
  const sel = selection();
  if (!s || !sel) return;
  const slot = nextFreeSlot(s, -1);
  if (slot === null) {
    setError("No free sample slots — clear one and try again.");
    return;
  }
  const result = bounceSelection(s, sel);
  if (!result) return;
  const patNum = s.orders[sel.order] ?? 0;
  // Short, grep-able name within PT's 22-char sample-name limit.
  const sourceName = `Bnc P${patNum.toString(16).toUpperCase()} R${sel.startRow
    .toString(16)
    .toUpperCase()
    .padStart(
      2,
      "0",
    )}-${sel.endRow.toString(16).toUpperCase().padStart(2, "0")}`;
  const wb = workbenchFromWavData(result.wav, sourceName);
  setError(null);
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: writeWorkbenchToSongPure(state.song, slot, wb, NO_LOOP),
    workbenches: withWorkbench(state.workbenches, slot, wb),
  }));
  selectSample(slot + 1);
}

export function loadWavIntoCurrentSample(
  bytes: Uint8Array,
  filename: string,
): void {
  let wb: SampleWorkbench;
  try {
    wb = workbenchFromWav(bytes, filename);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return;
  }
  setError(null);
  const slot = currentSample() - 1;
  // The freshly-loaded WAV supersedes any imported-sample side-stash —
  // the user explicitly replaced what was there.
  clearImportedStash(slot);
  // Preserve any active chiptune as the alt stash so the user can toggle
  // back to it without losing their synth params. If the slot already had
  // a sampler, keep its alt (the chiptune side, if any) so it survives the
  // overwrite — otherwise toggling kinds after re-loading a WAV would
  // forget the chiptune the user previously had.
  const existing = getWorkbench(slot);
  if (existing) {
    if (existing.source.kind === "chiptune") {
      wb = { ...wb, alt: workbenchToAlt(existing) };
    } else if (existing.alt) {
      wb = { ...wb, alt: existing.alt };
    }
  }
  const wbToCommit = wb;
  // NO_LOOP override clears any chiptune-era full-loop the slot might
  // still hold from a previous source-kind toggle.
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: writeWorkbenchToSongPure(state.song, slot, wbToCommit, NO_LOOP),
    workbenches: withWorkbench(state.workbenches, slot, wbToCommit),
  }));
}

/**
 * Range-aware kinds (reverse / crop / cut) honour the waveform selection
 * if any, mapped from int8 bytes to the chain's current output frame
 * space. volume / normalize / filter / shaper / crossfade ignore selection.
 */
export function addEffect(
  kind: EffectKind,
  selection: SampleSelection | null,
): void {
  const slot = currentSample() - 1;
  const wb = getWorkbench(slot);
  if (!wb) return;
  const s = song()?.samples[slot];
  if (!s) return;

  const chainOut = runChain(materializeSource(wb.source), wb.chain);
  let node: EffectNode;
  const isRangeAware = kind === "reverse" || kind === "crop" || kind === "cut";
  if (isRangeAware && selection && s.data.byteLength > 0) {
    const chainLen = chainOut.channels[0]?.length ?? 0;
    const int8Len = s.data.byteLength;
    const startFrame = Math.max(
      0,
      Math.min(chainLen, Math.round((selection.start * chainLen) / int8Len)),
    );
    const endFrame = Math.max(
      startFrame,
      Math.min(chainLen, Math.round((selection.end * chainLen) / int8Len)),
    );
    if (endFrame - startFrame < 1) return;
    node = { kind, params: { startFrame, endFrame } } as EffectNode;
  } else {
    node = defaultEffect(kind, chainOut);
  }
  const newIndex = wb.chain.length;
  updateCurrentWorkbench({ ...wb, chain: [...wb.chain, node] });
  // Auto-select the freshly-appended entry so its visual editor (the
  // envelope overlay) is immediately active without an extra click.
  // Filter defaults to the cutoff envelope; shaper to amount; volume
  // to its only envelope. Other kinds (normalize / range-aware /
  // crossfade) clear the param to null.
  setSelectedEffectIndex(newIndex);
  setSelectedEffectParam(defaultParamForKind(kind));
}

export function removeEffect(index: number): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  if (index < 0 || index >= wb.chain.length) return;
  // Indices shift after a removal — clearing is the simplest correct
  // policy. The user re-clicks if they were editing something downstream.
  setSelectedEffectIndex(null);
  setSelectedEffectParam(null);
  updateCurrentWorkbench({
    ...wb,
    chain: wb.chain.filter((_, i) => i !== index),
  });
}

export function moveEffect(index: number, delta: -1 | 1): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  const target = index + delta;
  if (target < 0 || target >= wb.chain.length) return;
  const chain = [...wb.chain];
  [chain[index], chain[target]] = [chain[target]!, chain[index]!];
  // Reorder breaks the selection invariant — the index now points at a
  // different node than the user clicked. Clear and let the user re-pick.
  setSelectedEffectIndex(null);
  setSelectedEffectParam(null);
  updateCurrentWorkbench({ ...wb, chain });
}

/** Replace one node's params (or whole node, for variants without params). */
export function patchEffect(index: number, next: EffectNode): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  if (index < 0 || index >= wb.chain.length) return;
  const chain = wb.chain.map((n, i) => (i === index ? next : n));
  updateCurrentWorkbench({ ...wb, chain });
}

/**
 * Toggle the bypass flag on chain[index]. A bypassed effect short-
 * circuits to a pass-through inside `applyEffect` (params are kept, so
 * un-bypassing restores the previous behaviour without re-entry).
 */
export function setEffectBypass(index: number, bypassed: boolean): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  const node = wb.chain[index];
  if (!node) return;
  // Drop the field entirely when re-enabling, so a reset effect serialises
  // bit-identical to its pre-bypass form (no `bypassed: false` cruft).
  const next: EffectNode = bypassed
    ? { ...node, bypassed: true }
    : (() => {
        const { bypassed: _drop, ...rest } = node;
        void _drop;
        return rest as EffectNode;
      })();
  patchEffect(index, next);
}

// ─── Envelope point editing ──────────────────────────────────────────────

/** Pull the envelope addressed by `(chainIndex, param)`, or null when
 *  the combination doesn't refer to a real envelope (wrong kind, wrong
 *  param for kind, missing chain entry). Returns a fresh array —
 *  callers mutate it freely. */
function envelopeAt(
  index: number,
  param: EnvelopeParamKey,
): EnvelopePoint[] | null {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return null;
  const node = wb.chain[index];
  if (!node) return null;
  if (param === "volume" && node.kind === "volume") {
    return [...node.params.points];
  }
  if (param === "cutoff" && node.kind === "filter") {
    return [...node.params.cutoff];
  }
  if (param === "q" && node.kind === "filter") {
    return [...node.params.q];
  }
  if (param === "amount" && node.kind === "shaper") {
    return [...node.params.amount];
  }
  if (param === "pitch" && node.kind === "pitch") {
    return [...node.params.envelope];
  }
  return null;
}

function clampValueForParam(v: number, param: EnvelopeParamKey): number {
  const axis = PARAM_AXES[param];
  return Math.max(axis.min, Math.min(axis.max, v));
}

function clampFrame(f: number): number {
  return Math.max(0, Math.floor(f));
}

/** Sort by frame, snap to integers, clamp value to the param's axis,
 *  dedupe identical-frame points (keeping the LAST one written — matches
 *  editor intent: drag finishing on top of an existing point overwrites
 *  it). */
function normaliseEnvelope(
  points: ReadonlyArray<EnvelopePoint>,
  param: EnvelopeParamKey,
): EnvelopePoint[] {
  const cleaned = points.map((p) => ({
    frame: clampFrame(p.frame),
    value: clampValueForParam(p.value, param),
  }));
  cleaned.sort((a, b) => a.frame - b.frame);
  const out: EnvelopePoint[] = [];
  for (const p of cleaned) {
    const prev = out[out.length - 1];
    if (prev && prev.frame === p.frame) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Build the new node for `chain[index]` with `param`'s envelope
 *  replaced. Returns null when the (kind, param) combination is invalid. */
function nodeWithUpdatedEnvelope(
  index: number,
  param: EnvelopeParamKey,
  points: EnvelopePoint[],
): EffectNode | null {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return null;
  const node = wb.chain[index];
  if (!node) return null;
  if (param === "volume" && node.kind === "volume") {
    return { kind: "volume", params: { points } };
  }
  if (param === "cutoff" && node.kind === "filter") {
    return { kind: "filter", params: { ...node.params, cutoff: points } };
  }
  if (param === "q" && node.kind === "filter") {
    return { kind: "filter", params: { ...node.params, q: points } };
  }
  if (param === "amount" && node.kind === "shaper") {
    return { kind: "shaper", params: { ...node.params, amount: points } };
  }
  if (param === "pitch" && node.kind === "pitch") {
    return { kind: "pitch", params: { envelope: points } };
  }
  return null;
}

function commitEnvelope(
  index: number,
  param: EnvelopeParamKey,
  points: EnvelopePoint[],
): void {
  if (points.length < ENVELOPE_MIN_POINTS) return;
  const next = nodeWithUpdatedEnvelope(index, param, points);
  if (!next) return;
  patchEffect(index, next);
}

export function addEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  point: EnvelopePoint,
): void {
  const points = envelopeAt(index, param);
  if (!points) return;
  commitEnvelope(index, param, normaliseEnvelope([...points, point], param));
}

export function removeEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  pointIndex: number,
): void {
  const points = envelopeAt(index, param);
  if (!points) return;
  if (points.length <= ENVELOPE_MIN_POINTS) return;
  if (pointIndex < 0 || pointIndex >= points.length) return;
  const next = points.filter((_, i) => i !== pointIndex);
  commitEnvelope(index, param, normaliseEnvelope(next, param));
}

export function patchEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  pointIndex: number,
  next: Partial<EnvelopePoint>,
): void {
  const points = envelopeAt(index, param);
  if (!points) return;
  if (pointIndex < 0 || pointIndex >= points.length) return;
  const cur = points[pointIndex]!;
  points[pointIndex] = {
    frame: next.frame !== undefined ? clampFrame(next.frame) : cur.frame,
    value:
      next.value !== undefined
        ? clampValueForParam(next.value, param)
        : cur.value,
  };
  commitEnvelope(index, param, normaliseEnvelope(points, param));
}

/**
 * Drag a segment between two adjacent points: shift both endpoints'
 * value by the same `deltaValue`. Frames stay put. Useful for raising
 * / lowering a flat region without nudging the slope at its edges.
 */
export function nudgeEnvelopeSegment(
  index: number,
  param: EnvelopeParamKey,
  leftPointIndex: number,
  deltaValue: number,
): void {
  const points = envelopeAt(index, param);
  if (!points) return;
  if (leftPointIndex < 0 || leftPointIndex >= points.length - 1) return;
  const a = points[leftPointIndex]!;
  const b = points[leftPointIndex + 1]!;
  points[leftPointIndex] = {
    frame: a.frame,
    value: clampValueForParam(a.value + deltaValue, param),
  };
  points[leftPointIndex + 1] = {
    frame: b.frame,
    value: clampValueForParam(b.value + deltaValue, param),
  };
  commitEnvelope(index, param, normaliseEnvelope(points, param));
}

/**
 * Burn the chain into the sampler source so the source no longer holds
 * the full-length pre-crop bytes. Motivation is project-file size: a
 * heavy Crop on a long source can be the difference between a 20 MB and
 * a 200 KB `.retro`. Slot int8 (and audio) are unchanged. No-op on
 * chiptune (regenerates from params) or an empty chain.
 */
export function applyChainToSource(): void {
  const slot = currentSample() - 1;
  const wb = getWorkbench(slot);
  if (!wb) return;
  if (wb.source.kind !== "sampler") return;
  if (wb.chain.length === 0) return;

  let burned = runChain(
    materializeSource(wb.source),
    wb.chain,
    runContextForSlot(slot),
  );

  // Drop bytes past `loopEnd` — never heard (the worklet plays through
  // `songForPlayback` which truncates for the same reason), and skipping
  // them shrinks the .retro further.
  const sample = song()?.samples[slot];
  if (sample && sample.loopLengthWords > 1 && sample.data.length > 0) {
    const sourceFrames = burned.channels[0]?.length ?? 0;
    if (sourceFrames > 0) {
      const ratio = sourceFrames / sample.data.length;
      const loopEndByte = (sample.loopStartWords + sample.loopLengthWords) * 2;
      const loopEndFrame = Math.min(
        sourceFrames,
        Math.floor(loopEndByte * ratio),
      );
      if (loopEndFrame > 0 && loopEndFrame < sourceFrames) {
        burned = {
          sampleRate: burned.sampleRate,
          channels: burned.channels.map((ch) => ch.slice(0, loopEndFrame)),
        };
      }
    }
  }

  // Pin the slot's current loop across the burn. Without this, the
  // post-burn re-render can come out 1 int8 byte shorter than the
  // pre-burn slot (resampler rounding), and `writeWorkbenchToSongPure`'s
  // `scaledLoop` rule then shaves the loop by ~one word per Apply
  // — `loopStartWords` slides toward 0 with every burn. The user
  // didn't ask the loop to move; it's just a re-encoding of the same
  // audio. `replaceSampleData` clamps if the saved bounds overshoot
  // the new (slightly shorter) data, so passing them through is safe.
  const loopOverride =
    sample && sample.loopLengthWords > 1
      ? {
          loopStartWords: sample.loopStartWords,
          loopLengthWords: sample.loopLengthWords,
        }
      : undefined;

  updateCurrentWorkbench(
    {
      ...wb,
      source: {
        kind: "sampler",
        wav: burned,
        sourceName: wb.source.sourceName,
      },
      chain: [],
    },
    loopOverride,
  );
}

export function setMonoMix(monoMix: MonoMix): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, monoMix } });
}

export function setTargetNote(targetNote: number | null): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, targetNote } });
}

export function setResampleMode(resampleMode: ResampleMode): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, resampleMode } });
}

export function setDither(dither: boolean): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, dither } });
}

/**
 * Set the fixed playback length (PAL ticks, 1/50 s) the PT transformer
 * resamples to. Pass null (or any non-positive / non-finite value) to
 * disable — the transformer's "no fixed length" branch fires and the
 * slot's int8 length goes back to the targetNote-driven default.
 */
export function setPlayingLengthTicks(ticks: number | null): void {
  const wb = getWorkbench(currentSample() - 1);
  if (!wb) return;
  const next =
    typeof ticks === "number" && Number.isFinite(ticks) && ticks > 0
      ? Math.floor(ticks)
      : null;
  updateCurrentWorkbench({
    ...wb,
    pt: { ...wb.pt, playingLengthTicks: next },
  });
}

/**
 * Non-destructive Sampler ↔ Chiptune toggle: the active half is stashed
 * in `wb.alt` and the target half is restored from `wb.alt` if it was
 * stashed there before. With no matching alt: chiptune gets fresh
 * defaults; sampler drops into the empty-sampler view (Load WAV
 * waiting), since Sampler has no useful "fresh" state without a WAV.
 *
 * "Imported" path (slot has int8 from a `.mod` but no workbench yet): on
 * the Imported→Chiptune transition we capture the slot's Sample into a
 * side-stash (the `wb.alt` mechanism is workbench-shaped and can't carry
 * the "no workbench" state). On the reverse transition, with that
 * side-stash present and no `wb.alt`, we drop the chiptune workbench and
 * restore the original int8 + meta — the slot returns to its true prior
 * "Imported, no workbench" state.
 */
export function setSourceKind(kind: SourceKind): void {
  if (transport() === "playing") return;
  const slot = currentSample() - 1;
  const wb = getWorkbench(slot);

  if (!wb) {
    if (kind === "chiptune") {
      // Capture the imported int8 + meta before the chiptune render
      // overwrites the slot's bytes — that's what lets the user click
      // back to "Imported" and get exactly what they had.
      const sample = song()?.samples[slot];
      if (sample && sample.lengthWords > 0) {
        stashImportedSample(slot, sample);
      }
      updateCurrentWorkbench(workbenchFromChiptune());
    }
    return;
  }
  if (wb.source.kind === kind) return;

  // Chiptune→Sampler with no alt-stashed sampler half but an imported
  // side-stash: restore the original int8 instead of dropping into a
  // fresh empty-sampler workbench. The user's mental model is "I
  // imported this, dabbled in chiptune, want my sample back" — not
  // "give me a blank sampler".
  if (kind === "sampler" && !wb.alt && wb.source.kind === "chiptune") {
    const stashed = getImportedStash(slot);
    if (stashed) {
      restoreImportedSample(slot, stashed);
      return;
    }
  }

  // Snapshot the slot's current loop into the alt — without it a sampler
  // with a loop would lose it on Sampler→Chiptune→Sampler (chiptune's
  // full-loop overwrites the slot's fields).
  const sample = song()?.samples[slot];
  const currentLoop = sample
    ? {
        loopStartWords: sample.loopStartWords,
        loopLengthWords: sample.loopLengthWords,
      }
    : null;
  const stash = workbenchToAlt(wb, currentLoop);

  // Sampler restore reuses the alt's captured loop. Chiptune restore
  // passes undefined so `sourceWantsFullLoop` recomputes the full-loop
  // against the current render — a stale captured loop would be wrong
  // if osc params (and thus cycle length) changed since the stash.
  if (wb.alt && wb.alt.source.kind === kind) {
    const restoreLoop =
      kind === "sampler" ? (wb.alt.loop ?? NO_LOOP) : undefined;
    updateCurrentWorkbench(
      {
        source: wb.alt.source,
        chain: wb.alt.chain,
        pt: wb.alt.pt,
        alt: stash,
      },
      restoreLoop,
    );
    return;
  }

  if (kind === "chiptune") {
    updateCurrentWorkbench({ ...workbenchFromChiptune(), alt: stash });
    return;
  }
  updateCurrentWorkbench({ ...emptySamplerWorkbench(), alt: stash }, NO_LOOP);
}

/**
 * Drop the slot's workbench AND restore its bytes / meta from the
 * imported side-stash. Used by the Chiptune→Imported click path: the
 * user wants their `.mod` sample back, not a fresh sampler workbench.
 *
 * Goes through `commitEditWithWorkbenches` so the song update and the
 * workbench removal share one undo entry — undo of this returns the
 * user to the chiptune render they came from.
 */
function restoreImportedSample(slot: number, sample: Sample): void {
  commitEditWithWorkbenches((state) => ({
    ...state,
    song: {
      ...state.song,
      samples: state.song.samples.map((s, i) => (i === slot ? sample : s)),
    },
    workbenches: withoutWorkbench(state.workbenches, slot),
  }));
  clearImportedStash(slot);
  // Live-preview swap so a held audition key picks up the restored bytes.
  const ap = activePreview();
  if (ap && ap.slot === slot) {
    const updatedSample = song()?.samples[slot];
    if (updatedSample) livePreviewSwap(slot, updatedSample, ap.period);
  }
}

export function updateChiptune(patch: Partial<ChiptuneParams>): void {
  const slot = currentSample() - 1;
  const wb = getWorkbench(slot);
  if (!wb || wb.source.kind !== "chiptune") return;
  const params: ChiptuneParams = { ...wb.source.params, ...patch };
  updateCurrentWorkbench({
    ...wb,
    source: { kind: "chiptune", params },
  });
}

/**
 * Wrap an existing int8 sample as a fresh sampler workbench. The slot's
 * int8 isn't rewritten, so the bytes stay exactly as the .mod stored
 * them until the user actually edits the chain.
 */
export function convertSlotToSampler(): void {
  const slot = currentSample() - 1;
  if (getWorkbench(slot)) return;
  const sample = song()?.samples[slot];
  if (!sample || sample.lengthWords <= 0 || sample.data.byteLength <= 0) return;
  const sourceName = (sample.name.trim() || `Sample ${slot + 1}`).slice(0, 22);
  // The slot now has a real sampler workbench wrapping these bytes; the
  // imported side-stash is no longer the canonical "previous state".
  clearImportedStash(slot);
  setWorkbench(slot, workbenchFromInt8(sample.data, sourceName));
}

/**
 * Freeze the synth output as a sampler source so the chain (filter / fade
 * / crop / …) becomes available while keeping the sound. Distinct from
 * the kind toggle: that one swaps in a fresh / stashed sampler half,
 * this one freezes the current chiptune render as the new source.
 *
 * `targetNote: null` so the sampler plays at native rate (matching how
 * chiptune played it). Chiptune params go to `alt` so the user can flip
 * back without losing their work.
 */
export function convertChiptuneToSampler(): void {
  if (transport() === "playing") return;
  const slot = currentSample() - 1;
  const wb = getWorkbench(slot);
  if (!wb || wb.source.kind !== "chiptune") return;
  const wav = materializeSource(wb.source);
  const sample = song()?.samples[slot];
  const currentLoop = sample
    ? {
        loopStartWords: sample.loopStartWords,
        loopLengthWords: sample.loopLengthWords,
      }
    : null;
  updateCurrentWorkbench({
    source: { kind: "sampler", wav, sourceName: "Chiptune render" },
    chain: [],
    pt: { monoMix: "average", targetNote: null },
    alt: workbenchToAlt(wb, currentLoop),
  });
}
