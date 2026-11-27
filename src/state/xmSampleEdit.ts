import { createSignal } from "solid-js";

import {
  defaultEffect,
  materializeSource,
  runChain,
  runXmPipeline,
  sourceDisplayName,
  sourceWantsFullLoop,
  type EffectKind,
  type EffectNode,
  type EnvelopeParamKey,
  type MonoMix,
  type ResampleMode,
  type RunContext,
  type SampleSource,
  type XmPlayingLength,
  type XmSampleWorkbench,
  type XmWorkbenchAlt,
  XM_DEFAULT_RESAMPLE_MODE,
  workbenchToAlt,
  xmWorkbenchFromChiptune,
  xmWorkbenchFromSample,
  xmWorkbenchToAlt,
  type SourceKind,
} from "../core/audio/sampleWorkbench";
import { makePipelineActions } from "./samplePipeline";
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
  type XmEditState,
} from "./song";
import { stopXmPreview, xmLivePreviewSwap } from "./xmPreview";
import { setError, sourcePending } from "./session";
import { settings } from "./settings";
import {
  currentXmInstrument,
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "./xmEdit";
import { xmSelection } from "./selection";
import {
  getXmWorkbench,
  setXmWorkbench,
  xmWorkbenchKey,
  withXmWorkbench,
  withoutXmInstrumentWorkbenches,
  withXmWorkbenchCopied,
} from "./xmSampleWorkbench";
import {
  clearXmInstrument as clearXmInstrumentMutation,
  clearXmSampleData as clearXmSampleDataMutation,
  commitXmSlotShape,
  duplicateXmSample as duplicateXmSampleMutation,
} from "./xmInstrumentEdit";
import {
  buildXmWavImport,
  deriveXmSampleName,
  tuneForSampleRate,
  type XmWavImport,
} from "../core/xm/sampleImport";
import { readWav, type WavData } from "../core/audio/wav";
import { xmC4Rate } from "../core/audio/xmFreqTable";
import { refitXmLoop, xmRenderTargetFor } from "../core/xm/sampleFit";
import {
  duplicateXmInstrument as duplicateXmInstrumentMutation,
  nextFreeXmInstrumentIndex,
  patchXmInstrumentSample,
  setXmInstrument,
  setXmInstrumentSample,
} from "../core/xm/mutations";
import { bounceXmSelection } from "../core/audio/xmBounce";
import { xmWorkbenchFromWav } from "../core/audio/sampleWorkbench";
import { effectiveXmSampleRate } from "./detectedPitch";
import { setXmSampleClipboard, xmSampleClipboard } from "./xmSampleClipboard";
import { setXmSampleSelection, xmSampleSelection } from "./xmSampleSelection";

void XM_DEFAULT_PATTERN_ROWS;
void workbenchToAlt;

export const [xmSelectedEffectIndex, setXmSelectedEffectIndex] = createSignal<
  number | null
>(null);

export const [xmSelectedEffectParam, setXmSelectedEffectParam] =
  createSignal<EnvelopeParamKey | null>(null);

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

function getOrInitCurrentXmWorkbench(): {
  wb: XmSampleWorkbench;
  inst1Based: number;
  sampleIdx: number;
  sample: XmSample;
  /** The song's frequency mode — the length fit needs it for the rate. */
  linearFreq: boolean;
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
    // The slot's real source is still being read after a boot restore —
    // wrapping the rendered bytes now would shadow it for good.
    if (sourcePending(xmWorkbenchKey(inst1Based, sampleIdx))) return null;
    wb = xmWorkbenchFromSample(
      sample.data,
      sample.bits,
      sample.name,
      effectiveXmSampleRate(sample, song.flags.linearFreq),
    );
    setXmWorkbench(inst1Based, sampleIdx, wb);
  }
  return {
    wb,
    inst1Based,
    sampleIdx,
    sample,
    linearFreq: song.flags.linearFreq,
  };
}

// Why: RunContext threads the slot's loop bounds into loop-aware chain
// effects (crossfade). The PT field names are byte-coordinate-flavoured;
// for XM, treat them as frame coordinates — applyCrossfade rescales by
// (inputLen / int8Length), which is dimensionless either way.
export function runContextForXmSample(
  sample: XmSample,
  loopOverride?: {
    loopStart: number;
    loopLength: number;
    loopType: XmSample["loopType"];
  },
): RunContext | null {
  const slotFrames = sample.data.length;
  if (slotFrames <= 0) return null;
  const loop = loopOverride ?? sample;
  if (loop.loopType === "none" || loop.loopLength <= 0) return null;
  return {
    loopStartByte: loop.loopStart,
    loopEndByte: loop.loopStart + loop.loopLength,
    int8Length: slotFrames,
  };
}

// Why: commitEditXmWithWorkbenches bundles workbench swap + sample-bytes update
// into one history entry. Without it, undo would roll back sample data while
// leaving the new chain/source on the workbench, desyncing the editor.
function updateCurrentXmWorkbench(
  next: XmSampleWorkbench,
  loopOverride?: {
    loopStart: number;
    loopLength: number;
    loopType: XmSample["loopType"];
  },
  // Why: a source-kind flip brings the other half's tuning with it — a
  // sampler's encodes its WAV's rate, a chiptune's is 0 / 0.
  tuningOverride?: { relativeNote: number; finetune: number },
): void {
  // Ungated, like PT's `updateCurrentWorkbench`: sync.ts forwards the
  // changed instrument to the worklet, so pipeline edits are heard while
  // the song plays. Callers that must not run mid-playback gate
  // themselves.
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { inst1Based, sampleIdx, sample } = ctx;
  const { data, bits } = runXmPipeline(
    next,
    runContextForXmSample(sample, loopOverride),
    xmRenderTargetFor(tuningOverride ?? sample, ctx.linearFreq),
  );
  // Same source and chain, different length: the terminal resampled the
  // same audio (a length fit was set, changed or cleared). The loop and
  // the waveform selection follow the sound instead of staying at frame
  // positions that now mean something else.
  const resampledOnly =
    next.source === ctx.wb.source &&
    next.chain === ctx.wb.chain &&
    data.length !== sample.data.length;
  // Why: loop policy priority — loopOverride (source-kind flip restore) >
  // chiptune full-cycle > sampler inherit-and-clamp.
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
    ({ loopStart, loopLength, loopType } = refitXmLoop(
      sample,
      sample.data.length,
      data.length,
      resampledOnly ? "scale" : "clamp",
    ));
  }
  const updatedSample: XmSample = {
    ...sample,
    ...tuningOverride,
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
  if (resampledOnly && sample.data.length > 0) {
    const sel = xmSampleSelection();
    if (sel) {
      const ratio = data.length / sample.data.length;
      setXmSampleSelection({
        start: Math.round(sel.start * ratio),
        end: Math.round(sel.end * ratio),
      });
    }
  }
  xmLivePreviewSwap();
}

const pipeline = makePipelineActions<XmSampleWorkbench>({
  getWorkbench: () => getOrInitCurrentXmWorkbench()?.wb ?? null,
  setWorkbench: (next) => updateCurrentXmWorkbench(next),
  setSelectedIndex: setXmSelectedEffectIndex,
  setSelectedParam: setXmSelectedEffectParam,
  defaultParamForKind,
});

/**
 * Append an effect to the chain. Range-aware kinds (reverse, crop, cut)
 * take the waveform `selection` as their range when there is one, as in
 * PT mode; every other kind, and a range-aware one with no selection,
 * gets its whole-sample defaults.
 */
export function addXmEffect(
  kind: EffectKind,
  selection: { start: number; end: number } | null = null,
): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const isRangeAware = kind === "reverse" || kind === "crop" || kind === "cut";
  if (isRangeAware && selection && ctx.sample.data.length > 0) {
    const range = selectionToXmChainFrames(
      ctx.wb,
      selection.start,
      selection.end,
      ctx.sample.data.length,
    );
    if (!range) return;
    pipeline.appendEffect({ kind, params: range } as EffectNode);
    return;
  }
  const chainOut = runChain(materializeSource(ctx.wb.source), ctx.wb.chain);
  pipeline.appendEffect(defaultEffect(kind, chainOut));
}

export const removeXmEffect = pipeline.removeEffect;
export const moveXmEffect = pipeline.moveEffect;
export const patchXmEffect = pipeline.patchEffect;
export const setXmEffectBypass = pipeline.setEffectBypass;
export const addXmChainEnvelopePoint = pipeline.addEnvelopePoint;
export const removeXmChainEnvelopePoint = pipeline.removeEnvelopePoint;
export const patchXmChainEnvelopePoint = pipeline.patchEnvelopePoint;
export const nudgeXmChainEnvelopeSegment = pipeline.nudgeEnvelopeSegment;

/** Burn the current chain into the source, replacing it with the chain
 *  output. The source becomes the post-chain audio so subsequent chain
 *  edits start from the realised result. Mirrors PT's applyChainToSource. */
export function applyXmChainToSource(): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
  if (wb.chain.length === 0) return;
  const realised = runChain(
    materializeSource(wb.source),
    wb.chain,
    runContextForXmSample(sample),
  );
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

/**
 * Fit the current sample to a musical length (see
 * `XmTransformerParams.playingLength`), or clear the fit with null. The
 * key is dropped rather than stored as null so an unfitted workbench
 * keeps the shape it always had.
 */
export function setXmPlayingLength(length: XmPlayingLength | null): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  const cur = wb.xm.playingLength ?? null;
  const valid =
    length !== null &&
    Number.isFinite(length.ticks) &&
    Number.isFinite(length.bpm) &&
    length.ticks > 0 &&
    length.bpm > 0;
  const next = valid ? { ticks: length.ticks, bpm: length.bpm } : null;
  if (cur?.ticks === next?.ticks && cur?.bpm === next?.bpm) return;
  const { playingLength: _drop, ...rest } = wb.xm;
  void _drop;
  updateCurrentXmWorkbench({
    ...wb,
    xm: next ? { ...rest, playingLength: next } : rest,
  });
}

export function setXmResampleMode(resampleMode: ResampleMode): void {
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb } = ctx;
  if ((wb.xm.resampleMode ?? XM_DEFAULT_RESAMPLE_MODE) === resampleMode) return;
  updateCurrentXmWorkbench({ ...wb, xm: { ...wb.xm, resampleMode } });
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
  if (transport() === "playing") return;
  // Why: lazy-create so empty instruments flip into chiptune instead of
  // silently no-opping; sampler workbench built here becomes the alt stash.
  ensureCurrentXmSampleExists();
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
  if (wb.source.kind === kind) return;
  // Why: stop preview before commit so the auto-swap in updateCurrentXmWorkbench
  // doesn't fire a fresh-sounding buffer on a source-kind flip.
  stopXmPreview();
  // Why: snapshot loop into the alt stash so flipping back restores it —
  // chiptune's full-cycle loop would otherwise overwrite sampler bounds.
  const currentLoop = {
    loopStart: sample.loopStart,
    loopLength: sample.loopLength,
    loopType: sample.loopType,
  };
  const stash = xmWorkbenchToAlt(wb, currentLoop, tuningOf(sample));
  if (wb.alt && wb.alt.source.kind === kind) {
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
      wb.alt.tuning,
    );
    return;
  }
  if (kind === "chiptune") {
    // A chiptune's pitch is its cycle length; it plays in tune at 0 / 0,
    // not at whatever rate the sampler's WAV was tuned for.
    updateCurrentXmWorkbench(
      { ...xmWorkbenchFromChiptune(), alt: stash },
      undefined,
      { relativeNote: 0, finetune: 0 },
    );
    return;
  }
  updateCurrentXmWorkbench({
    ...xmWorkbenchFromSample(new Int8Array(0), 8, "Sampler"),
    alt: stash,
  });
}

function tuningOf(sample: XmSample): {
  relativeNote: number;
  finetune: number;
} {
  return { relativeNote: sample.relativeNote, finetune: sample.finetune };
}

/**
 * The alt stash a slot's new sampler source should carry, so replacing
 * the audio (Load WAV, paste) doesn't forget the chiptune the slot had.
 * Mirrors PT's `loadWavIntoCurrentSample`: an active chiptune becomes
 * the alt; an existing sampler's alt (the chiptune side, if any) carries
 * over.
 */
function altForReplacedSource(
  existing: XmSampleWorkbench | undefined,
  sample: XmSample | undefined,
): XmWorkbenchAlt | null {
  if (!existing) return null;
  if (existing.source.kind !== "chiptune") return existing.alt;
  return xmWorkbenchToAlt(
    existing,
    sample
      ? {
          loopStart: sample.loopStart,
          loopLength: sample.loopLength,
          loopType: sample.loopType,
        }
      : undefined,
    sample ? tuningOf(sample) : undefined,
  );
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
  if (transport() === "playing") return;
  const ctx = getOrInitCurrentXmWorkbench();
  if (!ctx) return;
  const { wb, sample } = ctx;
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
    // Keep the chiptune params so toggling back restores the synth, as
    // PT's convert does.
    alt: altForReplacedSource(wb, sample),
  });
}

/** Reset the current slot to a fresh chiptune workbench, keeping the
 *  XM transformer settings the user already picked. */
export function newXmChiptune(): void {
  if (transport() === "playing") return;
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
export function nextFreeXmInstrumentSlot(): number | null {
  const s = xm2Song();
  return s ? nextFreeXmInstrumentIndex(s) : null;
}

/**
 * Render the current `xmSelection()` through the XM replayer into a
 * mono PCM buffer and drop it as a fresh instrument in the next empty
 * slot. The new instrument has a single 16-bit sample running through
 * an empty pipeline chain; the user can edit it like any other slot.
 * Mirrors PT2's `bounceSelectionToSample`.
 */
export function bounceXmSelectionToInstrument(): void {
  // Same gate as PT's bounce: refused only while Follow locks editing.
  if (transport() === "playing" && settings().followPlayback) return;
  const s = xm2Song();
  const sel = xmSelection();
  if (!s || !sel) return;
  const slot = nextFreeXmInstrumentSlot();
  if (slot === null) {
    setError("No free instrument slots — clear one and try again.");
    return;
  }
  // Tune the new sample as a 44.1 kHz import would be, then render at
  // exactly the rate that tuning plays at: the bounce is then frame for
  // frame what C-4 plays back, with no resampling in between. (Rendering
  // at 44100 and tuning afterwards left it a fraction of a percent off —
  // FT2's finetune can't land on 44100 exactly.)
  const linear = s.flags.linearFreq;
  const tuning = tuneForSampleRate(44100, linear);
  const sampleRate = Math.round(
    xmC4Rate(tuning.relativeNote, tuning.finetune, linear) ?? 44100,
  );
  const result = bounceXmSelection(s, sel, { sampleRate });
  if (!result) return;
  const patNum = s.orders[sel.order] ?? 0;
  const name = `Bnc P${patNum.toString(16).toUpperCase()} R${sel.startRow
    .toString(16)
    .toUpperCase()
    .padStart(2, "0")}-${sel.endRow
    .toString(16)
    .toUpperCase()
    .padStart(2, "0")}`.slice(0, XM_INSTRUMENT_NAME_MAX);
  // A sampler workbench at 16-bit so the bounce keeps its dynamic range;
  // the workbench is stored at (slot+1, 0) so chain edits keep working.
  const wb = xmWorkbenchFromWav(result.wav, name);
  const bytes = runXmPipeline(wb);
  const fresh = emptyXmInstrument();
  fresh.name = name;
  fresh.samples[0] = {
    ...fresh.samples[0]!,
    ...tuning,
    name,
    data: bytes.data,
    bits: bytes.bits,
  };
  setError(null);
  const committed = commitXmSlotShape((state) => ({
    song: setXmInstrument(state.song, slot, fresh),
    xmWorkbenches: withXmWorkbench(
      withoutXmInstrumentWorkbenches(state.xmWorkbenches, slot + 1),
      slot + 1,
      0,
      wb,
    ),
  }));
  if (!committed) return;
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
    relativeNote: sample.relativeNote,
    finetune: sample.finetune,
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
 *  replacing whatever was there — creating the instrument / sample when
 *  the slot doesn't exist yet, as PT pastes into any slot. The sample's
 *  bits flip to match the clipboard's so 16-bit copies survive a paste
 *  into an 8-bit slot, and it takes the copied sample's tuning: the
 *  bytes only play at the right pitch with the tuning they were cut
 *  from. */
export function pasteXmSampleBytes(): void {
  const clip = xmSampleClipboard();
  if (!clip) return;
  const s = xm2Song();
  if (!s) return;
  const inst1Based = currentXmInstrument();
  const sampleIdx = currentXmSampleIndex();
  const sample = s.instruments[inst1Based - 1]?.samples[sampleIdx];
  const pastedData: Int8Array | Int16Array =
    clip.bits === 8
      ? new Int8Array(clip.data as Int8Array)
      : new Int16Array(clip.data as Int16Array);
  const next: XmSample = {
    ...(sample ?? emptyXmSample()),
    data: pastedData,
    bits: clip.bits,
    relativeNote: clip.relativeNote ?? sample?.relativeNote ?? 0,
    finetune: clip.finetune ?? sample?.finetune ?? 0,
    // The old loop described the old audio; PT clears it on paste too.
    loopStart: 0,
    loopLength: 0,
    loopType: "none",
  };
  // Rebuild the workbench around the pasted bytes so subsequent chain
  // edits start from the new source — in the SAME undo entry as the
  // bytes, so undoing the paste also brings back the previous workbench
  // (it used to linger and re-render the pasted audio over the restored
  // sample on the next chain edit).
  const wb: XmSampleWorkbench = {
    ...xmWorkbenchFromSample(
      pastedData,
      clip.bits,
      clip.name ?? sample?.name ?? "",
      effectiveXmSampleRate(next, s.flags.linearFreq),
    ),
    alt: altForReplacedSource(getXmWorkbench(inst1Based, sampleIdx), sample),
  };
  const committed = commitXmSlotShape((state) => ({
    song: setXmInstrumentSample(state.song, inst1Based, next, sampleIdx),
    xmWorkbenches: withXmWorkbench(
      state.xmWorkbenches,
      inst1Based,
      sampleIdx,
      wb,
    ),
  }));
  if (committed) setXmSampleSelection(null);
}

// ─── Header actions (Load WAV / Duplicate / Clear) ───────────────────────

/**
 * Parse a WAV file's bytes and drop them into the active XM sample
 * slot. Mirrors PT2's `loadWavIntoCurrentSample`: the workbench's source
 * is the WAV as decoded (see `buildXmWavImport`), and a chiptune the
 * slot had is kept as the alt so the user can toggle back to it.
 *
 * Replacing an existing sample keeps its volume and panning but not its
 * tuning — that described the old audio's sample rate.
 */
export function loadXmWavIntoCurrentSample(
  bytes: Uint8Array,
  filename: string,
): void {
  const s = xm2Song();
  if (!s) return;
  let wav: WavData;
  try {
    wav = readWav(bytes);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return;
  }
  setError(null);
  const slot1Based = currentXmInstrument();
  const sampleIdx = currentXmSampleIndex();
  const current = s.instruments[slot1Based - 1]?.samples[sampleIdx];
  const imported = buildXmWavImport(
    wav,
    deriveXmSampleName(filename),
    s.flags.linearFreq,
    {
      keep: current,
      alt: altForReplacedSource(getXmWorkbench(slot1Based, sampleIdx), current),
    },
  );
  // Song bytes and workbench swap in ONE commit, so undo restores the
  // old audio and the old chain together.
  const committed = commitXmSlotShape((state) =>
    withXmWavImport(state, slot1Based, sampleIdx, imported),
  );
  if (!committed) return;
  setXmSampleSelection(null);
}

/** Land an imported WAV — sample bytes and its workbench — in one
 *  (instrument, sample) slot. */
export function withXmWavImport(
  state: XmEditState,
  inst1Based: number,
  sampleIdx: number,
  imported: XmWavImport,
): XmEditState {
  return {
    song: setXmInstrumentSample(
      state.song,
      inst1Based,
      imported.sample,
      sampleIdx,
    ),
    xmWorkbenches: withXmWorkbench(
      state.xmWorkbenches,
      inst1Based,
      sampleIdx,
      imported.wb,
    ),
  };
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
  if (!clearXmSampleDataMutation(instSlot, sampleIdx)) return;
  setXmSampleSelection(null);
}

/**
 * Deep-copy the active instrument into the next free slot and select it.
 * No-op when there's no free slot or the source instrument is empty.
 */
export function duplicateCurrentXmInstrument(): void {
  const s = xm2Song();
  if (!s) return;
  const sourceSlot = currentXmInstrument();
  const src = s.instruments[sourceSlot - 1];
  if (!src) return;
  const hasData = src.samples.some((sm) => sm.data.length > 0);
  if (!hasData) return;
  const targetSlot0 = nextFreeXmInstrumentSlot();
  if (targetSlot0 === null) {
    setError("No free instrument slots — clear one and try again.");
    return;
  }
  const targetSlot = targetSlot0 + 1;
  // The "free" target can still own workbenches (lazily created on an
  // empty slot); replace them with copies of the source instrument's so
  // each duplicated sample keeps the pipeline that rendered it.
  const committed = commitXmSlotShape((state) => {
    let wbs = withoutXmInstrumentWorkbenches(state.xmWorkbenches, targetSlot);
    for (let i = 0; i < src.samples.length; i++) {
      wbs = withXmWorkbenchCopied(wbs, sourceSlot, i, targetSlot, i);
    }
    return {
      song: duplicateXmInstrumentMutation(state.song, sourceSlot, targetSlot),
      xmWorkbenches: wbs,
    };
  });
  // Rejected (out-of-range slot, cap): nothing was copied, so don't
  // jump to the still-empty target slot.
  if (!committed) return;
  setCurrentXmInstrument(targetSlot0 + 1);
  setCurrentXmSampleIndex(0);
}

/**
 * Wipe the entire active instrument — samples, envelopes, autovibrato,
 * keymap, name — and drop every workbench keyed on that instrument so
 * the slot is genuinely reset. The active sample index resets to 0.
 */
export function clearCurrentXmInstrument(): void {
  const instSlot = currentXmInstrument();
  // The state action drops every `${instSlot}:*` workbench in the same
  // commit, so a future Load WAV on the slot can't inherit a stale chain.
  if (!clearXmInstrumentMutation(instSlot)) return;
  setXmSampleSelection(null);
  setCurrentXmSampleIndex(0);
}
