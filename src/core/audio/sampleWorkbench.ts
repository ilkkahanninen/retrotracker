/**
 * Sample workbench — a per-slot, session-only editing pipeline that lives
 * outside the ModSong.
 *
 *   source → effect chain → PT transformer → Int8Array
 *
 * The source is a `SampleSource` union: today either a loaded WAV (the
 * "Sampler" — kind: 'sampler') or a wavetable synth cycle (kind: 'chiptune').
 * `materializeSource` is the only place that knows how to turn either into a
 * WavData; everything downstream is shape-agnostic.
 *
 * Each effect is a pure `WavData → WavData` function. The terminal PT
 * transformer mixes to mono and quantises to 8-bit signed; its output is
 * written back into `song.samples[slot].data` via `replaceSampleData`.
 *
 * Playback reads the int8 data; it never touches the workbench. That's the
 * boundary: the pipeline shapes the int8, then we hand off to the replayer.
 *
 * Sampler workbenches don't survive a `.mod` save / re-load (their WAV
 * source bytes can be MB-sized, no good fit for localStorage / `.retro`).
 * Chiptune workbenches DO persist — their params are tiny, and the synth is
 * deterministic so re-running the pipeline reproduces the int8 exactly.
 */

import type { WavData } from "./wav";
import { readWav } from "./wav";
import { deriveSampleName, int8ToWav } from "../mod/sampleImport";
import { PAULA_CLOCK_PAL, PERIOD_TABLE } from "../mod/format";
import {
  type ChiptuneParams,
  defaultChiptuneParams,
  generateChiptuneCycle,
} from "./chiptune";
import { applyShaper, type ShaperMode } from "./shapers";
import type { XmLoopType } from "../xm/types";

/** PT note slot for "C-2" — the conventional default target for fresh imports. */
export const DEFAULT_TARGET_NOTE = 12;

// ─── Effect node types ───────────────────────────────────────────────────

/**
 * Range-aware effects (reverse, crop, cut) carry a [startFrame, endFrame)
 * over the chain's input — their per-effect input is the previous chain
 * stage's output, NOT the source.
 *
 * volume / filter / shaper carry one or more *envelopes* — piecewise-linear
 * curves of `n ≥ 2` points `{ frame, value }`. Linearly interpolated
 * between adjacent points; clamps to the boundary point's value outside
 * `[points[0].frame, points[last].frame]`. The volume envelope's value
 * is a gain multiplier; filter cutoff/Q and shaper drive use their own
 * domains (see PARAM_AXES). volume supersedes the older gain / fadeIn /
 * fadeOut effects.
 *
 * normalize takes no params — applies to the whole input.
 */
export type FilterType = "lowpass" | "highpass";

export interface EnvelopePoint {
  /** Frame index in this effect stage's input. Integer, ≥ 0. */
  frame: number;
  /**
   * The envelope's value at this frame. Domain depends on which param
   * the envelope drives — see PARAM_AXES. Volume envelope: multiplier
   * in [0, 2]. Filter cutoff: Hz. Filter q: quality factor. Shaper
   * amount: drive in [0, 1].
   */
  value: number;
}

/** Envelopes always carry at least 2 points so there's a segment to interpolate. */
export const ENVELOPE_MIN_POINTS = 2;

/**
 * Animatable envelope params. Each one owns a `ParamAxis` (see
 * PARAM_AXES) defining its valid range, scale (linear vs log), and
 * the color the overlay paints it in. Adding a new param means: add a
 * variant here, add a PARAM_AXES entry, route it through `envelopeAt`
 * in `sampleEdit.ts`, and update the per-frame application of whatever
 * effect owns the param.
 */
export type EnvelopeParamKey = "volume" | "cutoff" | "q" | "amount" | "pitch";

export interface ParamAxis {
  min: number;
  max: number;
  /** When true, distribute values logarithmically along the Y axis. */
  logarithmic: boolean;
  /** Tooltip / label suffix, e.g. "Hz". Empty string for unitless. */
  unit: string;
  /** CSS color for the curve + points. Defines the envelope's identity. */
  color: string;
}

/**
 * Per-param domain registry. Used by:
 *   - The overlay (`EnvelopeOverlay`) for Y-axis mapping + curve color.
 *   - The state-action helpers (`patchEnvelopePoint`, `nudgeEnvelopeSegment`)
 *     for value clamping.
 *   - The persistence migration to clamp legacy single-value params on read.
 */
export const PARAM_AXES: Readonly<Record<EnvelopeParamKey, ParamAxis>> = {
  // Volume: gain multiplier 0..2 (silence to ~+6 dB), 1.0 neutral.
  volume: { min: 0, max: 2, logarithmic: false, unit: "", color: "#ffa64d" },
  // Filter cutoff: Hz across the audible band. Log Y axis so the lower
  // octaves (where most musical content lives) get equal screen space.
  cutoff: {
    min: 10,
    max: 22050,
    logarithmic: true,
    unit: "Hz",
    color: "#5ec8ff",
  },
  // Filter Q: resonance / quality factor. 0.707 ≈ Butterworth (flat),
  // higher rings near cutoff. Linear axis is fine — the useful range is
  // narrow.
  q: { min: 0.1, max: 20, logarithmic: false, unit: "", color: "#9b87ff" },
  // Shaper drive: wet/dry blend 0..1.
  amount: { min: 0, max: 1, logarithmic: false, unit: "", color: "#7be3a3" },
  // Pitch / playback speed: multiplier on the input read pointer. 1.0 =
  // unchanged, 2.0 = octave up (twice as fast / half as long), 0.5 =
  // octave down. Two octaves each way is plenty for musical use; log Y
  // so each octave gets equal screen space (matches how pitch is
  // perceived).
  pitch: {
    min: 0.25,
    max: 4,
    logarithmic: true,
    unit: "×",
    color: "#ff85c0",
  },
};

/** Back-compat constants for the volume range. New code should read
 *  PARAM_AXES.volume.{min,max} directly. */
export const ENVELOPE_GAIN_MIN = PARAM_AXES.volume.min;
export const ENVELOPE_GAIN_MAX = PARAM_AXES.volume.max;

/**
 * Common fields every effect kind carries. Currently just `bypassed` —
 * an optional toggle that short-circuits the effect to a pass-through
 * (`applyEffect` returns the input unchanged) without removing the node
 * from the chain. Lets the user A/B an edit without losing its params.
 *
 * Optional + defaulting-to-false keeps old payloads byte-identical: an
 * effect with no `bypassed` field reads as not bypassed and serialises
 * without it.
 */
interface EffectNodeCommon {
  bypassed?: boolean;
}

export type EffectNode = EffectNodeCommon &
  (
    | { kind: "volume"; params: { points: ReadonlyArray<EnvelopePoint> } }
    | { kind: "normalize" }
    | { kind: "reverse"; params: { startFrame: number; endFrame: number } }
    | { kind: "crop"; params: { startFrame: number; endFrame: number } }
    | { kind: "cut"; params: { startFrame: number; endFrame: number } }
    | {
        kind: "filter";
        params: {
          /** 'lowpass' attenuates above cutoff, 'highpass' attenuates below. */
          type: FilterType;
          /** Cutoff envelope, values in Hz (clamped to [10, sourceRate/2) at apply time). */
          cutoff: ReadonlyArray<EnvelopePoint>;
          /** Resonance envelope, values in [0.05, 30]. ~0.707 ≈ Butterworth. */
          q: ReadonlyArray<EnvelopePoint>;
        };
      }
    | {
        kind: "crossfade";
        params: {
          /** Crossfade window length in source-frame units. */
          length: number;
        };
      }
    | {
        kind: "shaper";
        params: {
          /** Waveshaper mode — see SHAPER_MODES in shapers.ts. */
          mode: ShaperMode;
          /** Drive / wet-dry blend envelope, values in [0, 1]. */
          amount: ReadonlyArray<EnvelopePoint>;
        };
      }
    | {
        kind: "pitch";
        params: {
          /**
           * Per-frame playback-speed multiplier. The envelope's X axis is
           * input frames; at each input frame, the value defines how
           * quickly the read head advances (1.0 = original, 2.0 = twice
           * as fast → output half as long, 0.5 = half speed → output
           * twice as long). Values clamped to [0.25, 4] at apply time.
           * The output length is variable, computed from the integral of
           * 1/speed across the input.
           */
          envelope: ReadonlyArray<EnvelopePoint>;
        };
      }
  );

export type EffectKind = EffectNode["kind"];

export const EFFECT_KINDS: readonly EffectKind[] = [
  "volume",
  "normalize",
  "reverse",
  "crop",
  "cut",
  "filter",
  "crossfade",
  "shaper",
  "pitch",
] as const;

/** Human-readable names for the picker UI. */
export const EFFECT_LABELS: Readonly<Record<EffectKind, string>> = {
  volume: "Volume",
  normalize: "Normalize",
  reverse: "Reverse",
  crop: "Crop",
  cut: "Cut",
  filter: "Filter",
  crossfade: "Crossfade",
  shaper: "Shaper",
  pitch: "Pitch",
};

/**
 * Loop info threaded through the chain so loop-aware effects (currently
 * just crossfade) can reach the slot's loop boundaries.
 *
 * Stored in the slot's int8-byte coordinates plus the int8 length. Each
 * loop-aware effect re-derives its frame positions from its OWN input
 * length:
 *
 *   loopFrameInInput = loopByte * inputFrames / int8Length
 *
 * That formulation is robust to length-changing effects placed BEFORE the
 * loop-aware one — `crop → crossfade` works because the crossfade scales
 * the loop bytes against the cropped input, not the original source. The
 * older `loopStartFrame / loopEndFrame` form (derived once with the
 * source length) overshot a preceding crop's input bounds, then clamped,
 * so the fade landed in the wrong region and stopped tracking the user's
 * loop adjustments.
 *
 * Length-changing effects placed AFTER the loop-aware one (crop, cut)
 * still distort the mapping — the int8 region the user sees no longer
 * lines up with a single contiguous frame range in the crossfade output.
 * Those orderings are exotic and we don't try to handle them.
 */
export interface RunContext {
  /** Slot's loop start, in int8 byte position. */
  loopStartByte: number;
  /** Slot's loop end (exclusive), in int8 byte position. */
  loopEndByte: number;
  /** Length of the int8 data the byte positions index into. */
  int8Length: number;
}

export const FILTER_TYPE_LABELS: Readonly<Record<FilterType, string>> = {
  lowpass: "Low-pass",
  highpass: "High-pass",
};

export type MonoMix = "average" | "left" | "right";

/**
 * Sample-rate conversion algorithm used when the PT transformer resamples
 * the source down to the target-note rate (typically a 5:1 downsample for
 * a 44.1 kHz source at C-2). Picked per slot — most users want the default
 * but can flip to a heavier algorithm when a bright sample sounds aliased.
 *
 *   linear         — Fast, hop-and-skip linear interpolation. Aliases on
 *                    heavy downsamples (any source content above the new
 *                    Nyquist folds back as inharmonic tones), but cheap and
 *                    matches the historical behaviour.
 *   filteredLinear — Two cascaded Butterworth-ish biquad lowpasses at the
 *                    target Nyquist, then linear. Removes most of the
 *                    above-Nyquist energy before it can alias; ~24 dB/oct
 *                    rolloff. Inexpensive, audibly cleaner than `linear`.
 *   sinc           — Windowed-sinc (Lanczos-6) polyphase resampler. Sharp
 *                    cutoff right at the new Nyquist; minimal aliasing.
 *                    Highest quality, most CPU — but it's a one-shot offline
 *                    pass, so latency doesn't matter.
 */
export type ResampleMode = "linear" | "filteredLinear" | "sinc";

export const RESAMPLE_MODES: readonly ResampleMode[] = [
  "linear",
  "filteredLinear",
  "sinc",
] as const;

export const RESAMPLE_LABELS: Readonly<Record<ResampleMode, string>> = {
  linear: "Linear (fastest)",
  filteredLinear: "Linear + LPF",
  sinc: "Sinc (best)",
};

/** Default for fresh workbenches and persistence fallbacks. Linear keeps the
 *  historical behaviour for projects predating the `resampleMode` field. */
export const DEFAULT_RESAMPLE_MODE: ResampleMode = "linear";

export interface PtTransformerParams {
  monoMix: MonoMix;
  /**
   * PT note slot (0..35, where 0 = C-1, 12 = C-2, 24 = C-3, 35 = B-3) at
   * which the sample should play at its original speed. The transformer
   * resamples the mono signal so its rate equals what PT's Paula reads at
   * that note's period — i.e. triggering this note in a pattern plays the
   * source at the rate it was recorded.
   *
   * `null` disables resampling: the int8 data carries the source's original
   * rate, and PT will play it slowed (typically way down) when you trigger
   * a note in the standard 113..856 period range.
   */
  targetNote: number | null;
  /** Sample-rate conversion algorithm — see ResampleMode. Optional: workbenches
   *  that pre-date the field (loaded from old `.retro` files, or built by tests
   *  that don't care which resampler runs) fall back to `DEFAULT_RESAMPLE_MODE`
   *  inside `transformToPt`. New construction sites set it explicitly. */
  resampleMode?: ResampleMode;
  /** TPDF dither at ±1 LSB before the int8 round. Optional with a `false`
   *  fallback — old projects (and `workbenchFromInt8`-wrapped slots from a
   *  loaded `.mod`) stay bit-identical to historical output. Fresh WAV imports
   *  default to `true` since 8-bit quantisation noise correlates audibly with
   *  the signal on fade-outs / quiet tails. */
  dither?: boolean;
  /**
   * Force the output to play for exactly this many PAL ticks (1 tick = 1/50 s)
   * when triggered at `targetNote`. Resamples the post-effect signal so that
   * `frames × period_targetNote / PAULA_CLOCK = ticks / 50` seconds of
   * playback. null/undefined = disabled (default). Requires `targetNote` to
   * be set; ignored otherwise.
   */
  playingLengthTicks?: number | null;
}

// ─── Sources ──────────────────────────────────────────────────────────────

/**
 * The "front" of the pipeline. Generalised so a slot can be either a
 * traditional WAV-import sampler or a synthesised chiptune cycle. Adding
 * another kind (8SVX/IFF, FM patch, …) means a new variant + a clause in
 * `materializeSource`.
 *
 * The downstream chain + PT transformer don't care which kind produced the
 * WavData — they operate on raw audio.
 */
export type SampleSource =
  | { kind: "sampler"; wav: WavData; sourceName: string }
  | { kind: "chiptune"; params: ChiptuneParams };

export type SourceKind = SampleSource["kind"];

export const SOURCE_KINDS: readonly SourceKind[] = [
  "sampler",
  "chiptune",
] as const;

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  sampler: "Sampler",
  chiptune: "Chiptune",
};

/** Turn a source into the WavData the chain receives. Pure, deterministic. */
export function materializeSource(src: SampleSource): WavData {
  switch (src.kind) {
    case "sampler":
      return src.wav;
    case "chiptune":
      return generateChiptuneCycle(src.params);
  }
}

/** Display name for the pipeline header. */
export function sourceDisplayName(src: SampleSource): string {
  switch (src.kind) {
    case "sampler":
      return src.sourceName;
    case "chiptune":
      return "Chiptune";
  }
}

/**
 * Should the slot's loop be set to span the whole result on the first write?
 * Chiptune samples are looping by nature; sampler results aren't.
 */
export function sourceWantsFullLoop(src: SampleSource): boolean {
  return src.kind === "chiptune";
}

/**
 * Frozen snapshot of one half of a workbench (the "off" side after a
 * source-kind toggle). Holds source + chain + pt so toggling back restores
 * everything the user had on that side, not just the source.
 *
 * `loop` captures the slot's loop fields at stash time so toggling back to
 * a sampler half restores the loop the user had — without it, a sampler
 * with a loop would lose its loop the moment the user flipped to chiptune
 * (chiptune's `sourceWantsFullLoop` rule overwrites the slot's loop) and
 * back. Null means "no specific loop captured" (e.g. the alt was built
 * before the slot existed); restore falls through to default behaviour.
 */
export interface WorkbenchAlt {
  source: SampleSource;
  chain: EffectNode[];
  pt: PtTransformerParams;
  loop: { loopStartWords: number; loopLengthWords: number } | null;
}

export interface SampleWorkbench {
  /** Source feeding the chain — sampler (WAV) or chiptune (synth). */
  source: SampleSource;
  /** Effect chain, runs left-to-right. */
  chain: EffectNode[];
  /** Always-present terminal node. */
  pt: PtTransformerParams;
  /**
   * Stash of the workbench as it stood before the last kind-switch, so the
   * user can flip Sampler ↔ Chiptune and get back the WAV / chain / pt they
   * had on the other side. The stash is always the OPPOSITE kind to
   * `source` (when non-null), since a same-kind toggle is a no-op.
   *
   * Session-only: never round-trips through `.retro`. Reloading a project
   * restores `source` (chiptune persists; sampler doesn't) but not the alt.
   */
  alt: WorkbenchAlt | null;
}

/**
 * Pull the active half of a workbench into an alt-stash record. `loop`
 * (the slot's current loopStart/loopLength at stash time) is stored
 * alongside so restoring this alt later puts the loop back to where the
 * user had it — chiptune's full-loop rule would otherwise have erased it.
 */
export function workbenchToAlt(
  wb: SampleWorkbench,
  loop: { loopStartWords: number; loopLengthWords: number } | null = null,
): WorkbenchAlt {
  return { source: wb.source, chain: wb.chain, pt: wb.pt, loop };
}

// ─── Effects ──────────────────────────────────────────────────────────────

function mapChannels(
  input: WavData,
  fn: (ch: Float32Array) => Float32Array,
): WavData {
  return { sampleRate: input.sampleRate, channels: input.channels.map(fn) };
}

/**
 * Constant gain multiplier across every channel. Internal helper — the
 * volume effect uses `applyVolumeEnvelope` for piecewise gain, and
 * `applyNormalize` calls this with `1/peak`.
 */
function applyConstantGain(input: WavData, gain: number): WavData {
  if (gain === 1) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i]! * gain;
    return out;
  });
}

export function applyNormalize(input: WavData): WavData {
  let peak = 0;
  for (const ch of input.channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]!);
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return input; // silence
  return applyConstantGain(input, 1 / peak);
}

/**
 * Pre-sort an envelope's points by frame. The editor lets the user drag
 * a point past its neighbour mid-gesture, so the on-disk array isn't
 * guaranteed monotonic. Pre-sorting once and walking the sorted result
 * costs O(n log n) per chain run; with envelopes at most ~10 points
 * deep that's negligible.
 */
function sortEnvelope(
  points: ReadonlyArray<EnvelopePoint>,
): ReadonlyArray<EnvelopePoint> {
  if (points.length <= 1) return points;
  // Cheap monotonicity check — most envelopes ARE already sorted, so
  // we skip the copy in the common case.
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.frame < points[i - 1]!.frame) {
      return [...points].sort((a, b) => a.frame - b.frame);
    }
  }
  return points;
}

/**
 * Sample an envelope at integer frame `i`. Linear interpolation between
 * adjacent points; clamp-to-boundary outside `[points[0].frame, points[last].frame]`.
 *
 * Single-frame helper — for tight loops that want to read every frame,
 * pass an externally-cached `sorted` array (via `sortEnvelope`) and an
 * incrementally-advanced `segHint` to skip the segment search. The plain
 * 2-arg form does both internally and is fine for one-shot reads.
 */
export function evaluateEnvelopeAt(
  points: ReadonlyArray<EnvelopePoint>,
  i: number,
): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0]!.value;
  const sorted = sortEnvelope(points);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (i <= first.frame) return first.value;
  if (i >= last.frame) return last.value;
  for (let s = 0; s < sorted.length - 1; s++) {
    const a = sorted[s]!;
    const b = sorted[s + 1]!;
    if (i >= a.frame && i < b.frame) {
      const span = Math.max(1, b.frame - a.frame);
      return a.value + (b.value - a.value) * ((i - a.frame) / span);
    }
  }
  return last.value;
}

/**
 * Piecewise-linear volume envelope: multiplies the input's amplitude
 * frame-by-frame using the envelope's `value` (a gain multiplier).
 * Outside the range `[points[0].frame, points[last].frame]`, gain
 * clamps to the boundary point's value (DAW-style automation, not
 * pass-through). Inlines the segment walk for the hot loop instead of
 * calling `evaluateEnvelopeAt` per sample — same math, no per-frame
 * function-call overhead.
 */
export function applyVolumeEnvelope(
  input: WavData,
  points: ReadonlyArray<EnvelopePoint>,
): WavData {
  if (points.length < ENVELOPE_MIN_POINTS) return input;
  const sorted = sortEnvelope(points);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    let seg = 0; // index of the LEFT point of the current segment
    for (let i = 0; i < ch.length; i++) {
      let g: number;
      if (i <= first.frame) {
        g = first.value;
      } else if (i >= last.frame) {
        g = last.value;
      } else {
        // Advance segment until i falls inside [sorted[seg].frame, sorted[seg+1].frame).
        while (seg + 1 < sorted.length - 1 && i >= sorted[seg + 1]!.frame)
          seg++;
        const a = sorted[seg]!;
        const b = sorted[seg + 1]!;
        const span = Math.max(1, b.frame - a.frame);
        g = a.value + (b.value - a.value) * ((i - a.frame) / span);
      }
      out[i] = ch[i]! * g;
    }
    return out;
  });
}

/**
 * Reverse the frames in `[startFrame, endFrame)`. Frames outside that range
 * pass through untouched, so the effect only flips the selected slice — the
 * tail still plays forward, the head still plays forward, only the middle is
 * mirrored.
 */
export function applyReverse(
  input: WavData,
  startFrame: number,
  endFrame: number,
): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (e - s < 2) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < s; i++) out[i] = ch[i]!;
    for (let i = s; i < e; i++) out[i] = ch[s + (e - 1 - i)]!;
    for (let i = e; i < ch.length; i++) out[i] = ch[i]!;
    return out;
  });
}

/** Slice frames in [startFrame, endFrame). Indices are clamped to the source range. */
export function applyCrop(
  input: WavData,
  startFrame: number,
  endFrame: number,
): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (s === 0 && e === len) return input;
  return mapChannels(input, (ch) => ch.slice(s, e));
}

/**
 * Remove frames in [startFrame, endFrame) and concatenate what's left.
 * The inverse of crop: crop keeps the selection, cut keeps the rest.
 */
export function applyCut(
  input: WavData,
  startFrame: number,
  endFrame: number,
): WavData {
  const len = input.channels[0]?.length ?? 0;
  const s = Math.max(0, Math.min(len, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(len, Math.floor(endFrame)));
  if (s === e) return input; // empty cut → noop
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length - (e - s));
    out.set(ch.subarray(0, s), 0);
    out.set(ch.subarray(e), s);
    return out;
  });
}

/**
 * RBJ-cookbook biquad filter applied per-channel in Direct Form I. Each
 * channel runs its own pair of unit-delay states so cross-channel content
 * can't leak.
 *
 * Cutoff and Q are envelopes — sampled per frame, with coefficients
 * recomputed for each sample. At each frame:
 *   - cutoff is clamped to (10, Nyquist - 1) Hz
 *   - Q is clamped to (0.05, 30)
 *   - the biquad coefs (b0..b2, a0..a2) are re-derived
 * Cost: ~one Math.sin + Math.cos + a dozen multiplies per sample. The
 * chain runs offline at commit time so the cost is one-time, not per
 * playback frame.
 *
 * Out-of-range envelope values don't blow up — they just clamp to a
 * sane edge. Constant-envelope filters (a 2-point flat envelope, the
 * default) reproduce the previous "compute coefs once" output to within
 * floating-point noise.
 */
export function applyFilter(
  input: WavData,
  type: FilterType,
  cutoffEnv: ReadonlyArray<EnvelopePoint>,
  qEnv: ReadonlyArray<EnvelopePoint>,
): WavData {
  const sr = input.sampleRate;
  const sortedCutoff = sortEnvelope(cutoffEnv);
  const sortedQ = sortEnvelope(qEnv);

  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const f0 = Math.max(
        10,
        Math.min(sr * 0.5 - 1, evaluateEnvelopeAt(sortedCutoff, i)),
      );
      const Q = Math.max(0.05, Math.min(30, evaluateEnvelopeAt(sortedQ, i)));

      const w0 = (2 * Math.PI * f0) / sr;
      const cosW = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Q);

      // RBJ cookbook coefficients (https://www.w3.org/TR/audio-eq-cookbook/).
      let b0: number, b1: number, b2: number;
      if (type === "lowpass") {
        b0 = (1 - cosW) * 0.5;
        b1 = 1 - cosW;
        b2 = (1 - cosW) * 0.5;
      } else {
        // highpass
        b0 = (1 + cosW) * 0.5;
        b1 = -(1 + cosW);
        b2 = (1 + cosW) * 0.5;
      }
      const a0 = 1 + alpha;
      const a1 = -2 * cosW;
      const a2 = 1 - alpha;
      // Normalise so a0 = 1; saves a divide.
      const nb0 = b0 / a0;
      const nb1 = b1 / a0;
      const nb2 = b2 / a0;
      const na1 = a1 / a0;
      const na2 = a2 / a0;

      const x0 = ch[i]!;
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  });
}

/**
 * FT2-style loop crossfade. Replaces the last `length` frames of the loop
 * with a fade between the original loop tail (fading out) and the audio
 * just before `loopStart` (fading in). At the wrap point (`loopEnd-1`),
 * the audio has fully transitioned to "what comes just before loopStart",
 * so when DMA wraps from `loopEnd-1` to `loopStart` the next frame is the
 * naturally-adjacent original sample — no click.
 *
 * Length is clamped to fit the available room: at most `loopStart` (need
 * that many pre-loop samples), at most `loopEnd - loopStart` (must fit
 * inside the loop). With either constraint at zero the effect is a no-op.
 */
export function applyCrossfade(
  input: WavData,
  length: number,
  loopStartFrame: number,
  loopEndFrame: number,
): WavData {
  const len = input.channels[0]?.length ?? 0;
  const ls = Math.max(0, Math.min(len, Math.floor(loopStartFrame)));
  const le = Math.max(ls, Math.min(len, Math.floor(loopEndFrame)));
  const requested = Math.max(0, Math.floor(length));
  // Available room: pre-loop tail length AND loop length. We fade across
  // min of the three so the indices stay in-bounds and the loop content
  // outside the fade is preserved.
  const usable = Math.min(requested, ls, le - ls);
  if (usable <= 0) return input;
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    out.set(ch);
    for (let i = 0; i < usable; i++) {
      // t = 0 at the start of the fade window (audio still close to
      // original loop end); t = 1 at the very last frame of the loop
      // (audio matches `ch[ls - 1]`, so the wrap to `ch[ls]` is smooth).
      const t = usable > 1 ? i / (usable - 1) : 1;
      const targetIdx = le - usable + i;
      const sourceIdx = ls - usable + i;
      out[targetIdx] = (1 - t) * ch[targetIdx]! + t * ch[sourceIdx]!;
    }
    return out;
  });
}

/**
 * Per-sample waveshaper across every channel. Whole-input only — there's
 * no range param. `mode === 'none'` is a fast pass-through, matching the
 * shaper-stage contract from chiptune. The `amount` envelope is sampled
 * per frame so the user can ramp drive in / out across the sample.
 */
export function applyShaperEffect(
  input: WavData,
  mode: ShaperMode,
  amountEnv: ReadonlyArray<EnvelopePoint>,
): WavData {
  if (mode === "none") return input;
  const sortedAmount = sortEnvelope(amountEnv);
  return mapChannels(input, (ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const amount = Math.max(
        0,
        Math.min(1, evaluateEnvelopeAt(sortedAmount, i)),
      );
      out[i] = amount === 0 ? ch[i]! : applyShaper(ch[i]!, mode, amount);
    }
    return out;
  });
}

/**
 * Per-frame variable-speed resampler. The envelope (in INPUT-frame
 * coordinates) drives how fast the read pointer advances: at 1.0 the
 * output mirrors the input, at 2.0 it advances 2 input frames per
 * output frame (so output is half as long), at 0.5 the output is twice
 * as long. Linear interpolation reads fractional input positions.
 *
 * The output length is variable — `outLen ≈ ∫ (1/speed) dt` over the
 * input. We compute it lazily by walking until the read head exits the
 * input, capped at `MAX_PITCH_OUTPUT_FACTOR × inputLen` so a tiny
 * speed value can't run away.
 *
 * Speed values clamp to [PARAM_AXES.pitch.min, PARAM_AXES.pitch.max]
 * before use, so the editor's overlay range is enforced at apply time
 * even if the persisted envelope contains out-of-range data.
 */
const MAX_PITCH_OUTPUT_FACTOR = 8; // hard cap: 8× input length
export function applyPitch(
  input: WavData,
  envelope: ReadonlyArray<EnvelopePoint>,
): WavData {
  const inputLen = input.channels[0]?.length ?? 0;
  if (inputLen === 0) return input;
  if (envelope.length < ENVELOPE_MIN_POINTS) return input;
  const sorted = sortEnvelope(envelope);
  const minSpeed = PARAM_AXES.pitch.min;
  const maxSpeed = PARAM_AXES.pitch.max;
  // First pass: walk the envelope to compute the output length and
  // collect the source positions we'll read at each output frame.
  // Doing this once means the per-channel loop below doesn't recompute.
  const maxOutLen = Math.ceil(inputLen * MAX_PITCH_OUTPUT_FACTOR);
  const srcPositions = new Float64Array(maxOutLen);
  let outLen = 0;
  let srcPos = 0;
  while (outLen < maxOutLen && srcPos < inputLen - 1) {
    srcPositions[outLen] = srcPos;
    outLen++;
    const speed = Math.max(
      minSpeed,
      Math.min(maxSpeed, evaluateEnvelopeAt(sorted, Math.floor(srcPos))),
    );
    srcPos += speed;
  }
  if (outLen === 0) return mapChannels(input, () => new Float32Array(0));
  return mapChannels(input, (ch) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = srcPositions[i]!;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = ch[idx] ?? 0;
      const b = ch[idx + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  });
}

export function applyEffect(
  input: WavData,
  node: EffectNode,
  ctx?: RunContext | null,
): WavData {
  // Bypassed effects return their input verbatim. Returning the same
  // reference is safe — the chain treats inputs as immutable.
  if (node.bypassed) return input;
  switch (node.kind) {
    case "volume":
      return applyVolumeEnvelope(input, node.params.points);
    case "normalize":
      return applyNormalize(input);
    case "reverse":
      return applyReverse(input, node.params.startFrame, node.params.endFrame);
    case "crop":
      return applyCrop(input, node.params.startFrame, node.params.endFrame);
    case "cut":
      return applyCut(input, node.params.startFrame, node.params.endFrame);
    case "filter":
      return applyFilter(
        input,
        node.params.type,
        node.params.cutoff,
        node.params.q,
      );
    case "shaper":
      return applyShaperEffect(input, node.params.mode, node.params.amount);
    case "pitch":
      return applyPitch(input, node.params.envelope);
    case "crossfade": {
      // Loop info comes from the run context — without it (slot has no
      // loop, or the chain ran outside `writeWorkbenchToSongPure`) the
      // effect is a pass-through. Map the slot's int8-byte loop positions
      // into THIS effect's input frame space using the input length, so a
      // preceding crop / cut shrinks the mapping accordingly.
      if (!ctx || ctx.int8Length <= 0) return input;
      const inputLen = input.channels[0]?.length ?? 0;
      if (inputLen <= 0) return input;
      const ratio = inputLen / ctx.int8Length;
      return applyCrossfade(
        input,
        node.params.length,
        ctx.loopStartByte * ratio,
        ctx.loopEndByte * ratio,
      );
    }
  }
}

export function runChain(
  source: WavData,
  chain: EffectNode[],
  ctx?: RunContext | null,
): WavData {
  let cur = source;
  for (const node of chain) cur = applyEffect(cur, node, ctx);
  return cur;
}

// ─── PT transformer ───────────────────────────────────────────────────────

function averageChannels(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const len = channels[0]!.length;
  const nch = channels.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < nch; c++) sum += channels[c]![i]!;
    out[i] = sum / nch;
  }
  return out;
}

function floatToInt8(buf: Float32Array): Int8Array {
  const out = new Int8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(c * 127);
  }
  return out;
}

/**
 * Same as `floatToInt8` but with TPDF (triangular probability distribution)
 * dither at ±1 LSB before rounding. The dither decorrelates the quantisation
 * error from the signal: instead of harmonic distortion that tracks the
 * waveform, you get a steady ~-39 dB white-noise floor. Audibly cleaner on
 * fade-outs and quiet tails; the noise is below the int8 LSB so it's
 * imperceptible on full-scale content.
 *
 * `Math.random()` is fine here — this runs offline at chain-write time, and
 * the dither's audible effect doesn't depend on the PRNG's quality (any
 * uncorrelated source breaks the signal correlation).
 */
function floatToInt8Dithered(buf: Float32Array): Int8Array {
  const out = new Int8Array(buf.length);
  // 1/127 is the int8 LSB in [-1, 1] space; r is triangular in (-1, 1) × LSB.
  const lsb = 1 / 127;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const r = (Math.random() - Math.random()) * lsb;
    const c = v + r;
    const clamped = c < -1 ? -1 : c > 1 ? 1 : c;
    out[i] = Math.round(clamped * 127);
  }
  return out;
}

/**
 * Linear-interpolation resampler. Cheap, mildly aliasing on heavy
 * downsamples — fine for tracker work, where 8-bit quantisation dominates
 * the noise floor anyway. Output length is rounded so the duration stays
 * as close to the source as the integer-frame target allows; non-empty
 * inputs always produce at least one output frame.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (input.length === 0) return input;
  if (Math.abs(fromRate - toRate) < 1e-3) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Pre-filter the input with two cascaded biquad lowpasses at the target
 * Nyquist (~24 dB/oct rolloff), then linear-resample. The lowpass kills
 * the source content that would alias when the linear resampler hops over
 * it; passband stays Butterworth-flat near DC.
 *
 * Upsamples skip the filter entirely — there's nothing above the source
 * Nyquist to alias, and a lowpass at fromRate/2 would just dull the highs.
 *
 * Cutoff is set at 0.45 × toRate (a hair below Nyquist) to keep transition-
 * band ringing out of the audible passband. Q = 1/√2 (Butterworth-flat).
 */
export function resampleFilteredLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (input.length === 0) return input;
  if (Math.abs(fromRate - toRate) < 1e-3) return input;
  // Upsample: nothing to alias, plain linear suffices.
  if (toRate >= fromRate) return resampleLinear(input, fromRate, toRate);
  const cutoff = toRate * 0.45;
  const wrap: WavData = { sampleRate: fromRate, channels: [input] };
  // Wrap the constants as 2-point flat envelopes — `applyFilter` is
  // envelope-aware now, but a constant cutoff/Q produces the same
  // biquad response as the old "compute coefs once" form.
  const cutoffEnv: EnvelopePoint[] = [
    { frame: 0, value: cutoff },
    { frame: 1, value: cutoff },
  ];
  const qEnv: EnvelopePoint[] = [
    { frame: 0, value: Math.SQRT1_2 },
    { frame: 1, value: Math.SQRT1_2 },
  ];
  const stage1 = applyFilter(wrap, "lowpass", cutoffEnv, qEnv);
  const stage2 = applyFilter(stage1, "lowpass", cutoffEnv, qEnv);
  return resampleLinear(stage2.channels[0]!, fromRate, toRate);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Lanczos window parameter `a` — kernel half-width in normalised units.
 *  6 is a common "high-quality" pick: sharp cutoff, manageable kernel size. */
const LANCZOS_A = 6;

/**
 * Windowed-sinc (Lanczos-6) polyphase resampler. For downsamples the
 * kernel widens by `ratio` so its effective cutoff lands at the target
 * Nyquist instead of the source one — that's what removes alias-prone
 * content before the rate change. Per-output normalisation by the kernel
 * tap sum holds DC gain at 1 even at the input boundaries where the
 * window is truncated.
 *
 * Cost is O(outLen × kernelTaps) where kernelTaps ≈ 2·a·max(1, ratio) —
 * around 60 taps per output frame at a 5:1 downsample. One-shot offline,
 * so the user never feels it.
 */
export function resampleSinc(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (input.length === 0) return input;
  if (Math.abs(fromRate - toRate) < 1e-3) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  // Kernel scales with the downsample factor so the effective cutoff stays
  // at the new Nyquist; for upsamples the scale stays 1 (full source band).
  const scale = Math.max(1, ratio);
  const halfWidth = LANCZOS_A * scale;
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const start = Math.max(0, Math.ceil(srcPos - halfWidth));
    const end = Math.min(input.length - 1, Math.floor(srcPos + halfWidth));
    let acc = 0;
    let norm = 0;
    for (let j = start; j <= end; j++) {
      const x = (j - srcPos) / scale;
      const w = sinc(x) * sinc(x / LANCZOS_A);
      acc += input[j]! * w;
      norm += w;
    }
    out[i] = norm !== 0 ? acc / norm : 0;
  }
  return out;
}

function resampleByMode(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  mode: ResampleMode,
): Float32Array {
  switch (mode) {
    case "linear":
      return resampleLinear(input, fromRate, toRate);
    case "filteredLinear":
      return resampleFilteredLinear(input, fromRate, toRate);
    case "sinc":
      return resampleSinc(input, fromRate, toRate);
  }
}

/**
 * Convert a PT note slot (0..35) into the Paula playback rate it produces
 * at finetune 0. We resample the source to this rate so the sample plays at
 * its original speed when this note is triggered.
 */
export function rateForTargetNote(noteIndex: number): number | null {
  const period = PERIOD_TABLE[0]?.[noteIndex];
  if (!period || period <= 0) return null;
  // PAULA_CLOCK_PAL is the doubled CPU clock; PT divides by (period * 2).
  return PAULA_CLOCK_PAL / 2 / period;
}

export function transformToPt(
  audio: WavData,
  pt: PtTransformerParams,
): Int8Array {
  let mono: Float32Array;
  if (audio.channels.length === 0) {
    return new Int8Array(0);
  } else if (audio.channels.length === 1) {
    mono = audio.channels[0]!;
  } else if (pt.monoMix === "left") {
    mono = audio.channels[0]!;
  } else if (pt.monoMix === "right") {
    mono = audio.channels[1] ?? audio.channels[0]!;
  } else {
    mono = averageChannels(audio.channels);
  }

  // Resample to the rate PT will play this note at, so the user gets the
  // source at original speed when triggering that note in a pattern.
  if (pt.targetNote !== null) {
    const targetRate = rateForTargetNote(pt.targetNote);
    if (targetRate !== null) {
      // playingLengthTicks (when set, positive) overrides the output frame
      // count so the sample plays for exactly N PAL ticks at targetRate.
      // We re-derive an `effectiveRate` such that the resampler's
      // `round(input.length × toRate / fromRate)` formula yields exactly
      // the target frame count. The bytes still play at PT's
      // `rateForTargetNote(targetNote)`, so duration ends up at
      // `targetFrames / targetRate = ticks / 50` seconds.
      const ticks = pt.playingLengthTicks;
      const useFixedLength =
        typeof ticks === "number" && Number.isFinite(ticks) && ticks > 0;
      let toRate = targetRate;
      if (useFixedLength && mono.length > 0) {
        const targetFrames = Math.max(1, Math.round((ticks * targetRate) / 50));
        toRate = (audio.sampleRate * targetFrames) / mono.length;
      }
      mono = resampleByMode(
        mono,
        audio.sampleRate,
        toRate,
        pt.resampleMode ?? DEFAULT_RESAMPLE_MODE,
      );
    }
  }

  return pt.dither ? floatToInt8Dithered(mono) : floatToInt8(mono);
}

/** End-to-end: source → chain → PT transformer → Int8. */
export function runPipeline(
  workbench: SampleWorkbench,
  ctx?: RunContext | null,
): Int8Array {
  return transformToPt(
    runChain(materializeSource(workbench.source), workbench.chain, ctx),
    workbench.pt,
  );
}

// ─── Construction ─────────────────────────────────────────────────────────

/** Decode a WAV file into a fresh workbench with an empty effect chain. */
export function workbenchFromWav(
  bytes: Uint8Array,
  filename: string,
): SampleWorkbench {
  return workbenchFromWavData(
    readWav(bytes),
    deriveSampleName(filename) || filename,
  );
}

/**
 * Wrap an existing PT sample's int8 bytes as a Sampler workbench. Used
 * when loading a `.mod` so every populated slot gets a chain UI without
 * the user having to re-import. The WavData's `sampleRate` is set to the
 * C-2 target rate so the PT transformer's resampler short-circuits — an
 * empty-chain pipeline run reproduces the input bytes (modulo the lone
 * -128 → -127 quirk in `floatToInt8`). We don't auto-write through the
 * pipeline either, so the slot's int8 stays bit-identical until the user
 * actually edits the chain.
 */
export function workbenchFromInt8(
  data: Int8Array,
  sourceName: string,
): SampleWorkbench {
  const sampleRate = rateForTargetNote(DEFAULT_TARGET_NOTE) ?? 22050;
  return {
    source: { kind: "sampler", wav: int8ToWav(data, sampleRate), sourceName },
    chain: [],
    pt: {
      monoMix: "average",
      targetNote: DEFAULT_TARGET_NOTE,
      resampleMode: DEFAULT_RESAMPLE_MODE,
    },
    alt: null,
  };
}

/**
 * Same as `workbenchFromWav` but for already-decoded `WavData`. Used by the
 * `.retro` restore path, where the persistence layer has already decoded the
 * WAV bytes — re-running `readWav` would be wasted work and would also lose
 * the source name we stored separately.
 */
export function workbenchFromWavData(
  wav: WavData,
  sourceName: string,
): SampleWorkbench {
  return {
    source: { kind: "sampler", wav, sourceName },
    chain: [],
    // Default to C-2: when the user triggers C-2 in a pattern, the sample
    // plays at its original speed. They can change the target (or set null
    // to disable resampling entirely) from the Effects panel.
    //
    // Resampler defaults to `sinc` — fresh WAV imports tend to be 44.1 kHz
    // material that gets downsampled ~5:1 to the C-2 rate, where linear
    // interpolation aliases audibly. The .retro restore path overrides
    // `pt` from the saved payload, so previously-saved projects keep their
    // chosen mode. `DEFAULT_RESAMPLE_MODE` (linear) remains the back-compat
    // fallback for old payloads that pre-date the field.
    //
    // Dither stays off by default — adding white noise to every export is a
    // taste call, so the user opts in via the Dither checkbox.
    pt: {
      monoMix: "average",
      targetNote: DEFAULT_TARGET_NOTE,
      resampleMode: "sinc",
    },
    alt: null,
  };
}

/**
 * Build a fresh chiptune workbench. Uses `defaultChiptuneParams` and disables
 * PT resampling — pitch comes from the cycle length applied to the PT period
 * at playback time, not from rate conversion.
 */
export function workbenchFromChiptune(
  params: ChiptuneParams = defaultChiptuneParams(),
): SampleWorkbench {
  return {
    source: { kind: "chiptune", params },
    chain: [],
    pt: { monoMix: "average", targetNote: null },
    alt: null,
  };
}

/**
 * "Empty Sampler" workbench — a sampler whose source has no audio yet,
 * waiting for the user to Load WAV. Used when toggling Chiptune → Sampler
 * on a slot that has no remembered WAV: the workbench's view-mode flips to
 * Sampler, the chiptune side is preserved in `alt`, and the Load WAV
 * button becomes the path to actually populate the source.
 *
 * Materialised source is an empty mono WavData; the pipeline emits zero
 * bytes, which `replaceSampleData` collapses to a 0-length sample slot.
 */
export function emptySamplerWorkbench(): SampleWorkbench {
  return {
    source: {
      kind: "sampler",
      wav: { sampleRate: 22050, channels: [new Float32Array(0)] },
      sourceName: "",
    },
    chain: [],
    pt: {
      monoMix: "average",
      targetNote: DEFAULT_TARGET_NOTE,
      resampleMode: DEFAULT_RESAMPLE_MODE,
    },
    alt: null,
  };
}

/**
 * Default-parameter factory for newly-added effects. `input` is the WavData
 * the new effect will receive — i.e. the chain output up to this point, NOT
 * the workbench source. That way an effect appended after a crop gets
 * defaults sized to the cropped length, not the original source length.
 */
export function defaultEffect(kind: EffectKind, input: WavData): EffectNode {
  const len = input.channels[0]?.length ?? 0;
  switch (kind) {
    // Two flat points spanning the input — initially neutral. The user
    // shapes the envelope by adding / dragging points in the overlay.
    case "volume":
      return {
        kind: "volume",
        params: { points: flatEnvelope(1, len) },
      };
    case "normalize":
      return { kind: "normalize" };
    case "reverse":
      return { kind: "reverse", params: { startFrame: 0, endFrame: len } };
    case "crop":
      return { kind: "crop", params: { startFrame: 0, endFrame: len } };
    // Default Cut is a noop (empty range) — the user fills in start/end
    // either by editing the param fields or, in the common case, by
    // selecting on the waveform and clicking "Cut".
    case "cut":
      return { kind: "cut", params: { startFrame: 0, endFrame: 0 } };
    // 1 kHz / Q=0.707 — Butterworth-flat low-pass. Audible but tame
    // default that gives the user something to hear when they dial Q up
    // or sweep cutoff.
    case "filter":
      return {
        kind: "filter",
        params: {
          type: "lowpass",
          cutoff: flatEnvelope(1000, len),
          q: flatEnvelope(0.707, len),
        },
      };
    // Default crossfade window: a small fraction of the chain output, capped
    // at 4096 frames so it stays musical on long samples and tiny on short
    // ones. The actual cap is tightened at apply time by `applyCrossfade`
    // (≤ loopStart and ≤ loop length).
    case "crossfade":
      return {
        kind: "crossfade",
        params: { length: Math.min(4096, Math.max(1, Math.floor(len / 16))) },
      };
    // Soft clip at half-drive — audible without being aggressive, gives the
    // user something to hear immediately. They can pick a different mode or
    // dial drive from the param row.
    case "shaper":
      return {
        kind: "shaper",
        params: { mode: "softClip", amount: flatEnvelope(0.5, len) },
      };
    // Two flat points at speed 1.0 — initially a no-op. User drags
    // points to time-stretch / time-compress regions.
    case "pitch":
      return {
        kind: "pitch",
        params: { envelope: flatEnvelope(1, len) },
      };
  }
}

/** Build a 2-point flat envelope at constant `value` spanning [0, max(1, len-1)].
 *  Used by `defaultEffect` and the persistence layer for migration of legacy
 *  single-value params to envelopes. */
function flatEnvelope(value: number, len: number): EnvelopePoint[] {
  return [
    { frame: 0, value },
    { frame: Math.max(1, len - 1), value },
  ];
}

// ─── XM transformer ──────────────────────────────────────────────────────
//
// The FT2 sibling of `PtTransformerParams` / `transformToPt`. The chain is
// 100% reused — only the terminal stage differs:
//   - PT2 quantises the post-chain WavData to 8-bit signed, resampled to the
//     Paula period of the C-2 target note.
//   - FT2 quantises to 8-bit OR 16-bit signed, no resampling (XM stores its
//     own playback rate per sample via finetune + relativeNote).

export interface XmTransformerParams {
  /** Mix mode when the chain output has > 1 channel. */
  monoMix: MonoMix;
  /** 8 = Int8Array, 16 = Int16Array. */
  bitDepth: 8 | 16;
  /** Optional TPDF dither at the LSB before quantisation. Off by default
   *  — same opt-in policy as the PT pipeline. */
  dither?: boolean;
}

export interface XmTransformerOutput {
  data: Int8Array | Int16Array;
  bits: 8 | 16;
}

/** Convert the chain output to the XM sample shape. Mono-mixes, optionally
 *  dithers, and quantises to the requested bit depth. */
export function transformToXm(
  audio: WavData,
  xm: XmTransformerParams,
): XmTransformerOutput {
  let mono: Float32Array;
  if (audio.channels.length === 0) {
    return {
      data: xm.bitDepth === 8 ? new Int8Array(0) : new Int16Array(0),
      bits: xm.bitDepth,
    };
  } else if (audio.channels.length === 1) {
    mono = audio.channels[0]!;
  } else if (xm.monoMix === "left") {
    mono = audio.channels[0]!;
  } else if (xm.monoMix === "right") {
    mono = audio.channels[1] ?? audio.channels[0]!;
  } else {
    mono = averageChannels(audio.channels);
  }
  if (xm.bitDepth === 8) {
    return {
      data: xm.dither ? floatToInt8Dithered(mono) : floatToInt8(mono),
      bits: 8,
    };
  }
  return {
    data: xm.dither ? floatToInt16Dithered(mono) : floatToInt16(mono),
    bits: 16,
  };
}

function floatToInt16(buf: Float32Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(c * 32767);
  }
  return out;
}

function floatToInt16Dithered(buf: Float32Array): Int16Array {
  const out = new Int16Array(buf.length);
  const lsb = 1 / 32767;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const r = (Math.random() - Math.random()) * lsb;
    const c = v + r;
    const clamped = c < -1 ? -1 : c > 1 ? 1 : c;
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/**
 * Session-only workbench shape for FT2 instruments. Same `source` + `chain`
 * machinery as the PT-side `SampleWorkbench`; the terminal is the XM
 * transformer instead of the PT one, and the alt-stash for source-kind
 * toggle is sized for the XM terminal.
 */
export interface XmWorkbenchAlt {
  source: SampleSource;
  chain: EffectNode[];
  xm: XmTransformerParams;
  /**
   * Snapshot of the slot's sample loop at the moment this half was
   * stashed. Restored when the user toggles back so a sampler's loop
   * survives a chiptune detour (chiptune's full-cycle loop would
   * otherwise overwrite the loopStart / loopLength stored on the
   * sample). Absent on alts built before the loop-snapshot landed —
   * those simply inherit whatever loop is on the live sample.
   */
  loop?: { loopStart: number; loopLength: number; loopType: XmLoopType };
}

export interface XmSampleWorkbench {
  source: SampleSource;
  chain: EffectNode[];
  xm: XmTransformerParams;
  alt: XmWorkbenchAlt | null;
}

/** End-to-end: source → chain → XM transformer → int8 / int16 + bit depth. */
export function runXmPipeline(
  wb: XmSampleWorkbench,
  ctx?: RunContext | null,
): XmTransformerOutput {
  return transformToXm(
    runChain(materializeSource(wb.source), wb.chain, ctx),
    wb.xm,
  );
}

/** Wrap an existing XmSample (data + bits) as a Sampler workbench. Used
 *  when loading a `.xm` so every populated sample gets a chain UI without
 *  the user having to re-import. Mirrors `workbenchFromInt8` for PT. */
export function xmWorkbenchFromSample(
  data: Int8Array | Int16Array,
  bits: 8 | 16,
  sourceName: string,
): XmSampleWorkbench {
  // Build a Float32 WavData at a nominal rate (the chain doesn't depend on
  // this; the XM transformer doesn't resample). 8363 Hz is the conventional
  // XM "middle C" rate (the reference for finetune/relativeNote 0).
  const sampleRate = 8363;
  const ch = new Float32Array(data.length);
  if (bits === 8) {
    const src = data as Int8Array;
    for (let i = 0; i < src.length; i++) ch[i] = src[i]! / 127;
  } else {
    const src = data as Int16Array;
    for (let i = 0; i < src.length; i++) ch[i] = src[i]! / 32767;
  }
  return {
    source: {
      kind: "sampler",
      wav: { sampleRate, channels: [ch] },
      sourceName,
    },
    chain: [],
    xm: { monoMix: "average", bitDepth: bits },
    alt: null,
  };
}

/** Decode a fresh WAV file into an XM workbench. The PT side's
 *  `workbenchFromWavData` is for the PT terminal — XM has its own
 *  bit-depth / monoMix defaults and no Paula resampling. */
export function xmWorkbenchFromWav(
  wav: WavData,
  sourceName: string,
): XmSampleWorkbench {
  return {
    source: { kind: "sampler", wav, sourceName },
    chain: [],
    // FT2 supports 16-bit samples natively; default fresh imports to 16
    // bits so the user doesn't lose precision unintentionally.
    xm: { monoMix: "average", bitDepth: 16 },
    alt: null,
  };
}

/** Build a fresh chiptune workbench bound to the XM terminal. */
export function xmWorkbenchFromChiptune(
  params: ChiptuneParams = defaultChiptuneParams(),
): XmSampleWorkbench {
  return {
    source: { kind: "chiptune", params },
    chain: [],
    xm: { monoMix: "average", bitDepth: 8 },
    alt: null,
  };
}

/** Stash the active half of an XM workbench so the user can toggle
 *  sampler ↔ chiptune without losing the other side. `currentLoop`
 *  carries the slot's sample loop into the stash — restoring this
 *  half later (the reverse toggle) re-applies it so chiptune's full-
 *  cycle loop doesn't wipe the sampler's user-set loop bounds. */
export function xmWorkbenchToAlt(
  wb: XmSampleWorkbench,
  currentLoop?: { loopStart: number; loopLength: number; loopType: XmLoopType },
): XmWorkbenchAlt {
  return {
    source: wb.source,
    chain: wb.chain,
    xm: wb.xm,
    ...(currentLoop ? { loop: currentLoop } : {}),
  };
}
