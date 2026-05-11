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
  materializeSource,
  runChain,
  runXmPipeline,
  sourceDisplayName,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
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
import { commitEditXm, transport, xm2Song } from "./song";
import { setError } from "./session";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "./xmEdit";
import { xmSelection } from "./selection";
import { getXmWorkbench, setXmWorkbench } from "./xmSampleWorkbench";
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
 */
function updateCurrentXmWorkbench(next: XmSampleWorkbench): void {
  if (transport() === "playing") return;
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { inst1Based, sampleIdx, sample } = ctx;
  setXmWorkbench(inst1Based, sampleIdx, next);
  const { data, bits } = runXmPipeline(next);
  const updatedSample: XmSample = {
    ...sample,
    data,
    bits,
    // Loop fields are byte-indices into `data`. After a re-run the buffer
    // length may have changed; clamp the loop to the new bounds.
    loopStart: Math.min(sample.loopStart, Math.max(0, data.length - 1)),
    loopLength: Math.min(
      sample.loopLength,
      Math.max(0, data.length - sample.loopStart),
    ),
  };
  commitEditXm((s) =>
    setXmInstrumentSample(s, inst1Based, updatedSample, sampleIdx),
  );
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

export function setXmSourceKind(kind: SourceKind): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if (wb.source.kind === kind) return;
  // Flip: stash the current half, restore from alt if it matches the
  // target kind, otherwise build a fresh workbench of that kind.
  const stash = xmWorkbenchToAlt(wb);
  if (wb.alt && wb.alt.source.kind === kind) {
    updateCurrentXmWorkbench({
      source: wb.alt.source,
      chain: wb.alt.chain,
      xm: wb.alt.xm,
      alt: stash,
    });
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

void emptyXmSample;
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

/** Drop the selected frames from the sample (and pull the rest in to
 *  close the gap). Re-runs the workbench's pipeline through the new
 *  source so chain effects keep working. */
export function cutXmCurrentSampleSelection(start: number, end: number): void {
  if (transport() === "playing") return;
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample || sample.data.length === 0) return;
  const lo = Math.max(0, Math.min(sample.data.length, start));
  const hi = Math.max(lo, Math.min(sample.data.length, end));
  if (hi - lo < 1) return;
  const next = spliceSampleFrames(sample, lo, hi);
  commitSampleData(next);
}

/** Trim the sample down to the selected region. */
export function cropXmCurrentSampleToSelection(
  start: number,
  end: number,
): void {
  if (transport() === "playing") return;
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample || sample.data.length === 0) return;
  const lo = Math.max(0, Math.min(sample.data.length, start));
  const hi = Math.max(lo, Math.min(sample.data.length, end));
  if (hi - lo < 1) return;
  const next = cropSampleFrames(sample, lo, hi);
  commitSampleData(next);
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

/** Drop frames [start, end) from a sample, pulling subsequent frames
 *  forward. Loop fields shift / clamp into the new shorter buffer. */
function spliceSampleFrames(
  sample: XmSample,
  start: number,
  end: number,
): XmSample {
  const removed = end - start;
  const remaining = sample.data.length - removed;
  const next: Int8Array | Int16Array =
    sample.bits === 8 ? new Int8Array(remaining) : new Int16Array(remaining);
  // Frames before the cut.
  for (let i = 0; i < start; i++) next[i] = sample.data[i]!;
  // Frames after the cut, pulled forward.
  for (let i = end; i < sample.data.length; i++) {
    next[i - removed] = sample.data[i]!;
  }
  // Loop fields: drop into [0, remaining] window. If the loop straddled
  // the cut, the simplest correct policy is to clamp endpoints.
  const loopStart = Math.min(sample.loopStart, remaining);
  const loopEnd = Math.min(sample.loopStart + sample.loopLength, remaining);
  const loopLength = Math.max(0, loopEnd - loopStart);
  return {
    ...sample,
    data: next,
    loopStart,
    loopLength,
    loopType: loopLength > 0 ? sample.loopType : "none",
  };
}

/** Keep only frames [start, end) — the rest is discarded. */
function cropSampleFrames(
  sample: XmSample,
  start: number,
  end: number,
): XmSample {
  const len = end - start;
  const next: Int8Array | Int16Array =
    sample.bits === 8 ? new Int8Array(len) : new Int16Array(len);
  for (let i = 0; i < len; i++) next[i] = sample.data[start + i]!;
  // Loop fields: shift by `start`, clamp into [0, len].
  const loopStart = Math.max(0, Math.min(len, sample.loopStart - start));
  const loopEnd = Math.max(
    loopStart,
    Math.min(len, sample.loopStart + sample.loopLength - start),
  );
  const loopLength = loopEnd - loopStart;
  return {
    ...sample,
    data: next,
    loopStart,
    loopLength,
    loopType: loopLength > 0 ? sample.loopType : "none",
  };
}

/** Commit a fresh sample buffer into the current (instrument, sample)
 *  slot and rebuild the workbench around it so chain edits keep working. */
function commitSampleData(next: XmSample): void {
  commitEditXm((song) =>
    setXmInstrumentSample(
      song,
      currentXmInstrument(),
      next,
      currentXmSampleIndex(),
    ),
  );
  setXmWorkbench(
    currentXmInstrument(),
    currentXmSampleIndex(),
    xmWorkbenchFromWav(sampleBytesToWav(next.data, next.bits), next.name),
  );
  // The selection is now over a different buffer — clear it so the
  // overlay doesn't paint a stale rectangle.
  setXmSampleSelection(null);
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
