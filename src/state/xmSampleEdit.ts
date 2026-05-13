/**
 * FT2 sample-DSP actions — sibling to `state/sampleEdit.ts` (PT2). The
 * pipeline here uses the SAME source + chain primitives as PT2's
 * SampleWorkbench, but the terminal stage (XM transformer) writes the
 * resulting Int8 or Int16 payload into the active sample inside the
 * current instrument (instead of into a flat PT sample slot).
 *
 * Chain edits don't flow through the song-history machinery; they live
 * on the session-only XM workbench signal. The final sample-bytes commit
 * (after each chain run) goes through commitEditXm so undo eventually
 * walks back through the resulting XmSong states — coarser-grained than
 * PT2's elaborate workbench snapshots, but sufficient for v1.
 */

import { createSignal } from "solid-js";

import {
  defaultEffect,
  ENVELOPE_MIN_POINTS,
  materializeSource,
  runChain,
  runXmPipeline,
  sourceDisplayName,
  sourceWantsFullLoop,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type EnvelopePoint,
  type MonoMix,
  type SampleSource,
  type XmSampleWorkbench,
  workbenchToAlt,
  xmWorkbenchFromChiptune,
  xmWorkbenchFromSample,
  xmWorkbenchToAlt,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import {
  clampValueForParam,
  clampFrame,
  extractEnvelopeFromNode,
  nodeWithEnvelope,
  normaliseEnvelope,
} from "../core/audio/envelopeOps";
import {
  defaultChiptuneParams,
  type ChiptuneParams,
} from "../core/audio/chiptune";
import {
  emptyXmInstrument,
  emptyXmSample,
  XM_DEFAULT_PATTERN_ROWS,
} from "../core/xm/format";
import {
  XM_INSTRUMENT_NAME_MAX,
  XM_MAX_INSTRUMENTS,
  type XmSample,
} from "../core/xm/types";
import {
  commitEditXm,
  commitEditXmWithWorkbenches,
  transport,
  xm2Song,
} from "./song";
import { stopXmPreview, xmLivePreviewSwap } from "./xmPreview";
import { setError } from "./session";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "./xmEdit";
import { xmSelection } from "./selection";
import {
  clearXmWorkbench,
  getXmWorkbench,
  setXmWorkbench,
  withXmWorkbench,
  xmWorkbenches,
  setXmWorkbenchesRaw,
  xmWorkbenchKey,
} from "./xmSampleWorkbench";
import {
  clearXmInstrument as clearXmInstrumentMutation,
  clearXmSampleData as clearXmSampleDataMutation,
  duplicateXmSample as duplicateXmSampleMutation,
} from "./xmInstrumentEdit";
import { importWavXmSample } from "../core/xm/sampleImport";
import {
  patchXmInstrumentSample,
  setXmInstrument,
  setXmInstrumentSample,
} from "../core/xm/mutations";
import { bounceXmSelection } from "../core/audio/xmBounce";
import { xmWorkbenchFromWav } from "../core/audio/sampleWorkbench";
import { setXmSampleClipboard, xmSampleClipboard } from "./xmSampleClipboard";
import { setXmSampleSelection, xmSampleSelection } from "./xmSampleSelection";

void XM_DEFAULT_PATTERN_ROWS;
void workbenchToAlt;

// ─── Per-effect selection (envelope overlay focus) ───────────────────────
//
// The PT pipeline uses two signals: `selectedEffectIndex` to pin which
// chain entry the waveform overlay edits, and `selectedEffectParam` to
// pick *which* envelope of that entry (cutoff vs q, drive, etc.). We
// keep parallel signals for FT2; the XM waveform overlay editor lives
// in Wave C5.

export const [xmSelectedEffectIndex, setXmSelectedEffectIndex] = createSignal<
  number | null
>(null);

export const [xmSelectedEffectParam, setXmSelectedEffectParam] =
  createSignal<EnvelopeParamKey | null>(null);

/** Default envelope param for a freshly-added effect, when applicable. */
function defaultParamForKind(kind: EffectKind): EnvelopeParamKey | null {
  switch (kind) {
    case "volume":
      return "volume";
    case "filter":
      return "cutoff";
    case "shaper":
      return "amount";
    case "pitch":
      return "pitch";
    default:
      return null;
  }
}

// ─── Workbench resolution ────────────────────────────────────────────────

/**
 * Resolve the workbench for the currently selected (instrument, sample).
 * Lazy-creates one from the live sample bytes when none exists — so the
 * user can edit any sample even if it's never been touched in this
 * session. Returns null when no instrument / sample exists.
 */
function getOrInitCurrentXmWorkbench(): {
  wb: XmSampleWorkbench;
  inst1Based: number;
  sampleIdx: number;
  sample: XmSample;
} | null {
  const song = xm2Song();
  if (!song) return null;
  const inst1Based = currentXmInstrument();
  const inst = song.instruments[inst1Based - 1];
  if (!inst) return null;
  const sampleIdx = currentXmSampleIndex();
  const sample = inst.samples[sampleIdx];
  if (!sample) return null;
  let wb = getXmWorkbench(inst1Based, sampleIdx);
  if (!wb) {
    wb = xmWorkbenchFromSample(sample.data, sample.bits, sample.name);
    setXmWorkbench(inst1Based, sampleIdx, wb);
  }
  return { wb, inst1Based, sampleIdx, sample };
}

/**
 * Replace the current workbench AND re-run the pipeline into the
 * instrument's sample. The XM sample's loop / volume / finetune / etc.
 * meta stay put — only data + bits + length are touched.
 *
 * Routed through `commitEditXmWithWorkbenches` so the workbench swap
 * AND the resulting sample-bytes update land in the same history
 * entry. Without that, `undo` would roll back the sample data but
 * leave the new chain / source on the workbench, desyncing the editor.
 */
function updateCurrentXmWorkbench(
  next: XmSampleWorkbench,
  loopOverride?: {
    loopStart: number;
    loopLength: number;
    loopType: XmSample["loopType"];
  },
): void {
  if (transport() === "playing") return;
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { inst1Based, sampleIdx, sample } = ctx;
  const { data, bits } = runXmPipeline(next);
  // Loop policy, highest priority first:
  //   1. `loopOverride` — the source-kind toggle uses this to restore a
  //      sampler's loop when flipping back from chiptune. Without it,
  //      chiptune's full-cycle loop would persist on the slot.
  //   2. Chiptune source → full forward loop covering the cycle.
  //   3. Sampler source → inherit the slot's existing loop, clamped
  //      into the new buffer. If the original loop is entirely past
  //      the new buffer, `loopType` flips to "none".
  const isChiptune = sourceWantsFullLoop(next.source);
  let loopStart: number;
  let loopLength: number;
  let loopType: XmSample["loopType"];
  if (loopOverride) {
    loopStart = Math.max(0, Math.min(loopOverride.loopStart, data.length));
    const end = Math.max(
      loopStart,
      Math.min(loopOverride.loopStart + loopOverride.loopLength, data.length),
    );
    loopLength = end - loopStart;
    loopType = loopLength > 0 ? loopOverride.loopType : "none";
  } else if (isChiptune && data.length > 0) {
    loopStart = 0;
    loopLength = data.length;
    loopType = "forward";
  } else {
    const origLoopEnd = sample.loopStart + sample.loopLength;
    loopStart = Math.max(0, Math.min(sample.loopStart, data.length));
    const loopEnd = Math.max(loopStart, Math.min(origLoopEnd, data.length));
    loopLength = loopEnd - loopStart;
    loopType = loopLength > 0 ? sample.loopType : "none";
  }
  const updatedSample: XmSample = {
    ...sample,
    data,
    bits,
    loopStart,
    loopLength,
    loopType,
  };
  commitEditXmWithWorkbenches((state) => ({
    song: setXmInstrumentSample(
      state.song,
      inst1Based,
      updatedSample,
      sampleIdx,
    ),
    xmWorkbenches: withXmWorkbench(
      state.xmWorkbenches,
      inst1Based,
      sampleIdx,
      next,
    ),
  }));
  // Mirror PT2's updateCurrentWorkbench: re-render any in-flight
  // preview so a slider drag on the chiptune / chain params is
  // audible while a piano key's preview is still playing.
  xmLivePreviewSwap();
}

// ─── Chain ops ───────────────────────────────────────────────────────────

export function addXmEffect(kind: EffectKind): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  const chainOut = runChain(materializeSource(wb.source), wb.chain);
  const node = defaultEffect(kind, chainOut);
  const newIndex = wb.chain.length;
  updateCurrentXmWorkbench({ ...wb, chain: [...wb.chain, node] });
  setXmSelectedEffectIndex(newIndex);
  setXmSelectedEffectParam(defaultParamForKind(kind));
}

export function removeXmEffect(index: number): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (index < 0 || index >= wb.chain.length) return;
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  updateCurrentXmWorkbench({
    ...wb,
    chain: wb.chain.filter((_, i) => i !== index),
  });
}

export function moveXmEffect(index: number, delta: -1 | 1): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  const target = index + delta;
  if (target < 0 || target >= wb.chain.length) return;
  const chain = [...wb.chain];
  [chain[index], chain[target]] = [chain[target]!, chain[index]!];
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  updateCurrentXmWorkbench({ ...wb, chain });
}

export function patchXmEffect(index: number, next: EffectNode): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (index < 0 || index >= wb.chain.length) return;
  const chain = wb.chain.map((n, i) => (i === index ? next : n));
  updateCurrentXmWorkbench({ ...wb, chain });
}

// ─── Envelope-point edits (Wave C visual-parity additions) ───────────────
//
// Mirror PT2's addEnvelopePoint / removeEnvelopePoint / patchEnvelopePoint
// / nudgeEnvelopeSegment in sampleEdit.ts. The on-canvas envelope overlay
// on XmWaveform drives all four, with the same shape as PT2's overlay.

function xmEnvelopeAt(
  index: number,
  param: EnvelopeParamKey,
): EnvelopePoint[] | null {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return null;
  const node = ctx.wb.chain[index];
  if (!node) return null;
  return extractEnvelopeFromNode(node, param);
}

function commitXmEnvelope(
  index: number,
  param: EnvelopeParamKey,
  points: EnvelopePoint[],
): void {
  if (points.length < ENVELOPE_MIN_POINTS) return;
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const node = ctx.wb.chain[index];
  if (!node) return;
  const next = nodeWithEnvelope(node, param, points);
  if (!next) return;
  patchXmEffect(index, next);
}

export function addXmChainEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  point: EnvelopePoint,
): void {
  const points = xmEnvelopeAt(index, param);
  if (!points) return;
  commitXmEnvelope(index, param, normaliseEnvelope([...points, point], param));
}

export function removeXmChainEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  pointIndex: number,
): void {
  const points = xmEnvelopeAt(index, param);
  if (!points) return;
  if (points.length <= ENVELOPE_MIN_POINTS) return;
  if (pointIndex < 0 || pointIndex >= points.length) return;
  const next = points.filter((_, i) => i !== pointIndex);
  commitXmEnvelope(index, param, normaliseEnvelope(next, param));
}

export function patchXmChainEnvelopePoint(
  index: number,
  param: EnvelopeParamKey,
  pointIndex: number,
  next: Partial<EnvelopePoint>,
): void {
  const points = xmEnvelopeAt(index, param);
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
  commitXmEnvelope(index, param, normaliseEnvelope(points, param));
}

export function nudgeXmChainEnvelopeSegment(
  index: number,
  param: EnvelopeParamKey,
  leftPointIndex: number,
  deltaValue: number,
): void {
  const points = xmEnvelopeAt(index, param);
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
  commitXmEnvelope(index, param, normaliseEnvelope(points, param));
}

export function setXmEffectBypass(index: number, bypassed: boolean): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  const node = wb.chain[index];
  if (!node) return;
  const next: EffectNode = bypassed
    ? { ...node, bypassed: true }
    : (() => {
        const { bypassed: _drop, ...rest } = node;
        void _drop;
        return rest as EffectNode;
      })();
  patchXmEffect(index, next);
}

/** Burn the current chain into the source, replacing it with the chain
 *  output. The source becomes the post-chain audio so subsequent chain
 *  edits start from the realised result. Mirrors PT's applyChainToSource. */
export function applyXmChainToSource(): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
  if (wb.chain.length === 0) return;
  const realised = runChain(materializeSource(wb.source), wb.chain);
  // Replace the source with the realised WavData, clear the chain.
  const newSource: SampleSource = {
    kind: "sampler",
    wav: realised,
    sourceName: sample.name,
  };
  updateCurrentXmWorkbench({
    source: newSource,
    chain: [],
    xm: wb.xm,
    alt: wb.alt,
  });
}

// ─── Transformer panel setters ───────────────────────────────────────────

export function setXmMonoMix(monoMix: MonoMix): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (wb.xm.monoMix === monoMix) return;
  updateCurrentXmWorkbench({ ...wb, xm: { ...wb.xm, monoMix } });
}

export function setXmBitDepth(bitDepth: 8 | 16): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (wb.xm.bitDepth === bitDepth) return;
  updateCurrentXmWorkbench({ ...wb, xm: { ...wb.xm, bitDepth } });
}

export function setXmDither(dither: boolean): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if ((wb.xm.dither ?? false) === dither) return;
  const xm = dither
    ? { ...wb.xm, dither: true }
    : (() => {
        const { dither: _drop, ...rest } = wb.xm;
        void _drop;
        return rest as typeof wb.xm;
      })();
  updateCurrentXmWorkbench({ ...wb, xm });
}

// ─── Source-kind toggle (sampler ↔ chiptune) ─────────────────────────────

/**
 * Materialise the current (instrument, sample) slot if it's still
 * unallocated. A freshly-created XM song has `instruments: []`, so
 * clicking a source tab on instrument 1 would otherwise no-op — the
 * WAV-load path already lazy-creates here, and the source-picker
 * affordance should do the same.
 */
function ensureCurrentXmSampleExists(): void {
  if (transport() === "playing") return;
  const song = xm2Song();
  if (!song) return;
  const slot1Based = currentXmInstrument();
  const sampleIdx = currentXmSampleIndex();
  if (slot1Based < 1 || slot1Based > XM_MAX_INSTRUMENTS) return;
  const inst = song.instruments[slot1Based - 1];
  if (inst && inst.samples[sampleIdx]) return;
  commitEditXm((s) =>
    setXmInstrumentSample(s, slot1Based, emptyXmSample(), sampleIdx),
  );
}

export function setXmSourceKind(kind: SourceKind): void {
  // Lazy-create the slot first so the empty-instrument case (typical
  // for a fresh XM song) flips into chiptune instead of silently
  // no-opping. `getOrInitCurrentXmWorkbench` then builds the sampler
  // workbench from the empty sample, which becomes the `alt` stash
  // when we switch over.
  ensureCurrentXmSampleExists();
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
  if (wb.source.kind === kind) return;
  // A source-kind flip replaces the slot's audible content wholesale.
  // Stop any in-flight preview before the workbench commit so the
  // auto-swap in `updateCurrentXmWorkbench` doesn't fire a fresh-
  // sounding buffer the user didn't ask for. (Slider drags within
  // one kind still morph gaplessly — they go through `updateXm…`
  // without this gate.)
  stopXmPreview();
  // Snapshot the slot's current sample loop into the stash so flipping
  // back later restores it — chiptune's full-cycle loop would otherwise
  // overwrite the sampler's loop bounds.
  const currentLoop = {
    loopStart: sample.loopStart,
    loopLength: sample.loopLength,
    loopType: sample.loopType,
  };
  const stash = xmWorkbenchToAlt(wb, currentLoop);
  if (wb.alt && wb.alt.source.kind === kind) {
    // Restore the alt half AND its captured loop (when present). Chiptune
    // never needs an override — its loop is always the full cycle, so we
    // omit `wb.alt.loop` on the chiptune branch.
    const restoreLoop =
      kind === "chiptune" ? undefined : (wb.alt.loop ?? undefined);
    updateCurrentXmWorkbench(
      {
        source: wb.alt.source,
        chain: wb.alt.chain,
        xm: wb.alt.xm,
        alt: stash,
      },
      restoreLoop,
    );
    return;
  }
  const fresh =
    kind === "chiptune"
      ? xmWorkbenchFromChiptune()
      : xmWorkbenchFromSample(new Int8Array(0), 8, "Sampler");
  updateCurrentXmWorkbench({ ...fresh, alt: stash });
}

export function updateXmChiptune(patch: Partial<ChiptuneParams>): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (wb.source.kind !== "chiptune") return;
  const params: ChiptuneParams = { ...wb.source.params, ...patch };
  updateCurrentXmWorkbench({
    ...wb,
    source: { kind: "chiptune", params },
  });
}

/** Convert the current slot from chiptune → sampler by realising the
 *  chiptune cycle as the sampler's WAV. */
export function convertXmChiptuneToSampler(): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (wb.source.kind !== "chiptune") return;
  // Same affordance as `setXmSourceKind`: stop the preview so the
  // mid-flight buffer doesn't keep playing against the new sampler
  // half (or, worse, restart from frame 0).
  stopXmPreview();
  const realised = materializeSource(wb.source);
  const newSource: SampleSource = {
    kind: "sampler",
    wav: realised,
    sourceName: "Chiptune",
  };
  updateCurrentXmWorkbench({
    source: newSource,
    chain: wb.chain,
    xm: wb.xm,
    alt: null,
  });
}

/** Reset the current slot to a fresh chiptune workbench, keeping the
 *  XM transformer settings the user already picked. */
export function newXmChiptune(): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  updateCurrentXmWorkbench({
    source: { kind: "chiptune", params: defaultChiptuneParams() },
    chain: [],
    xm: wb.xm,
    alt: wb.alt,
  });
}

void patchXmInstrumentSample;

// ─── Bounce ──────────────────────────────────────────────────────────────

/** Find the lowest empty instrument slot (0-based, capped at
 *  XM_MAX_INSTRUMENTS). Returns null when all 128 are taken. */
function nextFreeXmInstrumentSlot(): number | null {
  const s = xm2Song();
  if (!s) return null;
  for (let i = 0; i < XM_MAX_INSTRUMENTS; i++) {
    const inst = s.instruments[i];
    if (!inst) return i;
    if (
      inst.samples.length === 0 ||
      inst.samples.every((sm) => sm.data.length === 0)
    ) {
      return i;
    }
  }
  return null;
}

/**
 * Render the current `xmSelection()` through the XM replayer into a
 * mono PCM buffer and drop it as a fresh instrument in the next empty
 * slot. The new instrument has a single 16-bit sample running through
 * an empty pipeline chain; the user can edit it like any other slot.
 * Mirrors PT2's `bounceSelectionToSample`.
 */
export function bounceXmSelectionToInstrument(): void {
  if (transport() === "playing") return;
  const s = xm2Song();
  const sel = xmSelection();
  if (!s || !sel) return;
  const slot = nextFreeXmInstrumentSlot();
  if (slot === null) {
    setError("No free instrument slots — clear one and try again.");
    return;
  }
  const result = bounceXmSelection(s, sel);
  if (!result) return;
  const patNum = s.orders[sel.order] ?? 0;
  const name = `Bnc P${patNum.toString(16).toUpperCase()} R${sel.startRow
    .toString(16)
    .toUpperCase()
    .padStart(2, "0")}-${sel.endRow
    .toString(16)
    .toUpperCase()
    .padStart(2, "0")}`.slice(0, XM_INSTRUMENT_NAME_MAX);
  // Build a sampler workbench at 16-bit so the bounce keeps its
  // dynamic range; run the pipeline immediately to get the bytes.
  const wb = xmWorkbenchFromWav(result.wav, name);
  // Build a fresh instrument with one sample carrying the rendered
  // bytes. setXmInstrument lands it in the chosen slot; the workbench
  // is stored at (slot+1, 0) so subsequent chain edits keep working.
  const fresh = emptyXmInstrument();
  fresh.name = name;
  // Pipeline output drives the actual bytes — uses the workbench's
  // 16-bit transformer choice so the bounce keeps headroom.
  const bytes = runXmPipeline(wb);
  fresh.samples[0] = {
    ...fresh.samples[0]!,
    name,
    data: bytes.data,
    bits: bytes.bits,
  };
  setError(null);
  commitEditXm((song) => setXmInstrument(song, slot, fresh));
  setXmWorkbench(slot + 1, 0, wb);
  setCurrentXmInstrument(slot + 1);
  setCurrentXmSampleIndex(0);
}

// ─── Sample-bytes clipboard / range edits ────────────────────────────────
//
// FT2 sibling of PT2's `copySampleRange / cutSampleRange /
// cropCurrentSampleToSelection / pasteSampleFromClipboard`. Operates on
// frame ranges over the sample's data array (which is Int8Array for
// 8-bit samples, Int16Array for 16-bit). The half-open `[start, end)`
// indices come from the waveform's drag selection; the App-level
// clipboard router supplies a "whole sample" range when no selection is
// active via `effectiveXmSampleRange()`.

/** Resolve the frame range an end-user clipboard op should act on.
 *  Selection wins; otherwise fall back to the whole sample. Returns
 *  null when there's nothing to act on (no song / no slot / empty
 *  data). */
export function effectiveXmSampleRange(): {
  start: number;
  end: number;
} | null {
  const s = xm2Song();
  if (!s) return null;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return null;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample || sample.data.length === 0) return null;
  const len = sample.data.length;
  const sel = xmSampleSelection();
  if (sel && sel.end - sel.start >= 1) {
    const start = Math.max(0, Math.min(len, sel.start));
    const end = Math.max(start, Math.min(len, sel.end));
    if (end - start < 1) return null;
    return { start, end };
  }
  return { start: 0, end: len };
}

/** Slice the active sample's frames onto the XM clipboard. No-op on an
 *  empty range. Frames are deep-copied so a later cut / pipeline edit
 *  doesn't mutate the clipboard payload. */
export function copyXmSampleRange(start: number, end: number): void {
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample || sample.data.length === 0) return;
  const lo = Math.max(0, Math.min(sample.data.length, start));
  const hi = Math.max(lo, Math.min(sample.data.length, end));
  if (hi - lo < 1) return;
  const slice: Int8Array | Int16Array =
    sample.bits === 8
      ? (sample.data as Int8Array).slice(lo, hi)
      : (sample.data as Int16Array).slice(lo, hi);
  setXmSampleClipboard({
    data: slice,
    bits: sample.bits,
    name: sample.name,
  });
}

/**
 * Map a sample-frame selection into the frame-range the next chain
 * effect would receive. The new effect runs at the END of the chain,
 * so the input length equals the current chain output. The sample's
 * visible data length matches that chain output (no resampling at the
 * XM transformer), so the mapping is identity-by-frame — modulo the
 * clamp to chain length when an upstream effect has already changed
 * the buffer size.
 */
function selectionToXmChainFrames(
  wb: XmSampleWorkbench,
  startFrame: number,
  endFrame: number,
  sampleLen: number,
): { startFrame: number; endFrame: number } | null {
  const chainOut = runChain(materializeSource(wb.source), wb.chain);
  const chainLen = chainOut.channels[0]?.length ?? 0;
  if (chainLen === 0 || sampleLen === 0) return null;
  const startF = Math.max(
    0,
    Math.min(chainLen, Math.round((startFrame * chainLen) / sampleLen)),
  );
  const endF = Math.max(
    startF,
    Math.min(chainLen, Math.round((endFrame * chainLen) / sampleLen)),
  );
  if (endF - startF < 1) return null;
  return { startFrame: startF, endFrame: endF };
}

/**
 * Append a Crop / Cut effect to the chain. Non-destructive — removing
 * the effect from the chain restores the original buffer. Mirrors
 * PT2's `applySelectionEdit` (which also goes through the chain when a
 * workbench is available).
 */
function applyXmSelectionEdit(
  kind: "crop" | "cut",
  startFrame: number,
  endFrame: number,
): void {
  if (transport() === "playing") return;
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
  if (sample.data.length === 0) return;
  const frames = selectionToXmChainFrames(
    wb,
    startFrame,
    endFrame,
    sample.data.length,
  );
  if (!frames) return;
  const effect: EffectNode = { kind, params: frames };
  updateCurrentXmWorkbench({ ...wb, chain: [...wb.chain, effect] });
  // The selection is over the pre-edit buffer; with a chain effect in
  // the way, the same frame indices now address different audio. Drop
  // the selection so the overlay doesn't paint a stale rectangle.
  setXmSampleSelection(null);
}

/** Append a Cut effect (drop the selected frames from the chain
 *  output). Non-destructive — undo by removing the effect from the
 *  pipeline. */
export function cutXmCurrentSampleSelection(start: number, end: number): void {
  applyXmSelectionEdit("cut", start, end);
}

/** Append a Crop effect (trim the chain output to the selected
 *  region). Non-destructive — undo by removing the effect. */
export function cropXmCurrentSampleToSelection(
  start: number,
  end: number,
): void {
  applyXmSelectionEdit("crop", start, end);
}

/** Copy + cut combined — same shape as PT's `cutSampleRange`. */
export function cutXmSampleRange(start: number, end: number): void {
  copyXmSampleRange(start, end);
  cutXmCurrentSampleSelection(start, end);
}

/** Paste the XM clipboard's bytes into the current sample slot,
 *  replacing whatever was there. The sample's bits flip to match the
 *  clipboard's bits so 16-bit copies survive a paste into an 8-bit
 *  slot. */
export function pasteXmSampleBytes(): void {
  if (transport() === "playing") return;
  const clip = xmSampleClipboard();
  if (!clip) return;
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample) return;
  const pastedData: Int8Array | Int16Array =
    clip.bits === 8
      ? new Int8Array(clip.data as Int8Array)
      : new Int16Array(clip.data as Int16Array);
  const next: XmSample = {
    ...sample,
    data: pastedData,
    bits: clip.bits,
    // Clamp the loop into the new payload bounds. The user can re-pin
    // it in the sample-meta row if they want a specific region.
    loopStart: Math.min(sample.loopStart, pastedData.length),
    loopLength: Math.min(
      sample.loopLength,
      Math.max(0, pastedData.length - sample.loopStart),
    ),
  };
  commitEditXm((song) =>
    setXmInstrumentSample(
      song,
      currentXmInstrument(),
      next,
      currentXmSampleIndex(),
    ),
  );
  // Rebuild the workbench around the pasted bytes so subsequent chain
  // edits start from the new source.
  setXmWorkbench(
    currentXmInstrument(),
    currentXmSampleIndex(),
    xmWorkbenchFromWav(
      sampleBytesToWav(pastedData, clip.bits),
      clip.name ?? sample.name,
    ),
  );
}

function sampleBytesToWav(
  data: Int8Array | Int16Array,
  bits: 8 | 16,
): { sampleRate: number; channels: Float32Array[] } {
  const sampleRate = 8363;
  const ch = new Float32Array(data.length);
  if (bits === 8) {
    const src = data as Int8Array;
    for (let i = 0; i < src.length; i++) ch[i] = src[i]! / 127;
  } else {
    const src = data as Int16Array;
    for (let i = 0; i < src.length; i++) ch[i] = src[i]! / 32767;
  }
  return { sampleRate, channels: [ch] };
}

// ─── Header actions (Load WAV / Duplicate / Clear) ───────────────────────

/**
 * Parse a WAV file's bytes and drop them into the active XM sample
 * slot. Mirrors PT2's `loadWavIntoCurrentSample`. Resets the workbench
 * so subsequent chain edits start from the freshly-loaded source.
 */
export function loadXmWavIntoCurrentSample(
  bytes: Uint8Array,
  filename: string,
): void {
  const s = xm2Song();
  if (!s) return;
  let imported: ReturnType<typeof importWavXmSample>;
  try {
    imported = importWavXmSample(bytes, filename);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return;
  }
  setError(null);
  const slot1Based = currentXmInstrument();
  const sampleIdx = currentXmSampleIndex();
  const inst = s.instruments[slot1Based - 1];
  const current = inst?.samples[sampleIdx];
  // Lazy-create the instrument + sample when the user drops a WAV onto
  // an empty slot. Preserve any user-set fields on the destination
  // sample (volume/panning/finetune/relativeNote) so reloading a WAV
  // doesn't erase tuning.
  const next: XmSample = current
    ? {
        ...current,
        name: imported.sample.name,
        data: imported.sample.data,
        bits: imported.sample.bits,
        loopStart: 0,
        loopLength: 0,
        loopType: "none",
      }
    : imported.sample;
  commitEditXm((song) =>
    setXmInstrumentSample(song, slot1Based, next, sampleIdx),
  );
  setXmWorkbench(
    slot1Based,
    sampleIdx,
    xmWorkbenchFromWav(sampleBytesToWav(next.data, next.bits), next.name),
  );
  setXmSampleSelection(null);
}

/** Duplicate the active sample into the next slot on the same
 *  instrument. Thin wrapper over the mutation; lives here so the
 *  InstrumentView only imports from xmSampleEdit. */
export function duplicateCurrentXmSample(): void {
  duplicateXmSampleMutation(currentXmInstrument(), currentXmSampleIndex());
}

/** Wipe the active sample's data + loop fields and drop its workbench
 *  so the next chain edit starts from a clean slate. */
export function clearCurrentXmSample(): void {
  const instSlot = currentXmInstrument();
  const sampleIdx = currentXmSampleIndex();
  clearXmSampleDataMutation(instSlot, sampleIdx);
  clearXmWorkbench(instSlot, sampleIdx);
  setXmSampleSelection(null);
}

/**
 * Wipe the entire active instrument — samples, envelopes, autovibrato,
 * keymap, name — and drop every workbench keyed on that instrument so
 * the slot is genuinely reset. The active sample index resets to 0.
 */
export function clearCurrentXmInstrument(): void {
  const instSlot = currentXmInstrument();
  clearXmInstrumentMutation(instSlot);
  // Drop every workbench whose key starts with `${instSlot}:` so a
  // future Load WAV on the same slot doesn't inherit a stale chain.
  const wbs = xmWorkbenches();
  const prefix = `${instSlot}:`;
  let mutated = false;
  const next = new Map(wbs);
  for (const key of wbs.keys()) {
    if (key.startsWith(prefix)) {
      next.delete(key);
      mutated = true;
    }
  }
  if (mutated) setXmWorkbenchesRaw(next);
  void xmWorkbenchKey;
  setXmSampleSelection(null);
  setCurrentXmSampleIndex(0);
}
