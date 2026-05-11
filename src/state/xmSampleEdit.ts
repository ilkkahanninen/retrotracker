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

// ─── Sample-bytes clipboard ──────────────────────────────────────────────
//
// FT2 sibling of PT2's `copySampleRange / cutSampleRange /
// pasteSampleFromClipboard`. Operates on whole samples for now — an
// on-waveform selection editor is a separate UI feature. Routed via the
// App's "view==sample" clipboard branch so ⌘C / ⌘X / ⌘V hit the right
// clipboard depending on which view is active.

/** Copy the current sample's bytes (full buffer) to the XM clipboard. */
export function copyXmSampleBytes(): void {
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample || sample.data.length === 0) return;
  const copyData: Int8Array | Int16Array =
    sample.bits === 8
      ? new Int8Array(sample.data as Int8Array)
      : new Int16Array(sample.data as Int16Array);
  setXmSampleClipboard({
    data: copyData,
    bits: sample.bits,
    name: sample.name,
  });
}

/** Copy + clear the current sample's bytes. The slot stays; just the
 *  payload is wiped. The XM workbench (if any) is replaced with one
 *  that wraps the now-empty buffer. */
export function cutXmSampleBytes(): void {
  if (transport() === "playing") return;
  copyXmSampleBytes();
  const s = xm2Song();
  if (!s) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  const sample = inst.samples[currentXmSampleIndex()];
  if (!sample) return;
  const emptied: XmSample = {
    ...sample,
    data: sample.bits === 8 ? new Int8Array(0) : new Int16Array(0),
    loopStart: 0,
    loopLength: 0,
    loopType: "none",
  };
  commitEditXm((song) =>
    setXmInstrumentSample(
      song,
      currentXmInstrument(),
      emptied,
      currentXmSampleIndex(),
    ),
  );
  // Reset the workbench so the next chain edit sees an empty source.
  setXmWorkbench(
    currentXmInstrument(),
    currentXmSampleIndex(),
    xmWorkbenchFromWav(
      { sampleRate: 8363, channels: [new Float32Array(0)] },
      emptied.name,
    ),
  );
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
