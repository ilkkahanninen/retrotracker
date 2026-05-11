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
import { emptyXmSample, XM_DEFAULT_PATTERN_ROWS } from "../core/xm/format";
import type { XmSample } from "../core/xm/types";
import { commitEditXm, transport, xm2Song } from "./song";
import { currentXmInstrument, currentXmSampleIndex } from "./xmEdit";
import { getXmWorkbench, setXmWorkbench } from "./xmSampleWorkbench";
import {
  patchXmInstrumentSample,
  setXmInstrumentSample,
} from "../core/xm/mutations";

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
