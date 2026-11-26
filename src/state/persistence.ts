import { parseModule } from "../core/mod/parser";
import { writeModule } from "../core/mod/writer";
import {
  CHANNELS,
  MAX_ORDERS,
  ROWS_PER_PATTERN,
  type ModSong,
} from "../core/mod/types";
import type { Song } from "../core/song";
import { parseXm } from "../core/xm/parser";
import { writeXm } from "../core/xm/writer";
import {
  XM_MAX_CHANNELS,
  XM_MAX_ORDERS,
  XM_MAX_PATTERN_ROWS,
  type XmSong,
} from "../core/xm/types";
import { FIELDS, type Cursor, type Field } from "./cursor";
import type { View } from "./view";
import type { ChiptuneParams } from "../core/audio/chiptune";
import { chiptuneFromJson } from "../core/audio/chiptune";
import type { WavData } from "../core/audio/wav";
import { readWav, writeWav } from "../core/audio/wav";
import type {
  EffectNode,
  EnvelopeParamKey,
  EnvelopePoint,
  MonoMix,
  PtTransformerParams,
  ResampleMode,
  XmTransformerParams,
} from "../core/audio/sampleWorkbench";
import {
  DEFAULT_RESAMPLE_MODE,
  DEFAULT_TARGET_NOTE,
  ENVELOPE_MIN_POINTS,
  PARAM_AXES,
  RESAMPLE_MODES,
  materializeSource,
  runChain,
} from "../core/audio/sampleWorkbench";
import { SHAPER_MODES, type ShaperMode } from "../core/audio/shapers";
import {
  getSourceStore,
  setSourceStore,
  type SourceStore,
} from "./sourceStore";

/**
 * Local-storage session persistence.
 *
 * The song itself round-trips through `writeModule` / `parseModule` — the
 * binary M.K. format is the canonical, lossless representation, base64 just
 * makes it fit through localStorage's string interface. This costs ~33% size
 * vs. the binary but keeps the persistence path identical to "Save .mod"
 * and "Open .mod" so we never invent a JSON shape we'd have to migrate.
 *
 * The handful of UI signals (cursor, view, current sample / octave / edit
 * step, filename) are bundled around the song bytes as plain JSON.
 *
 * Source workbenches persist (chain + PT params don't — those reset to
 * defaults on load, but the int8 in the song bytes plays back identically):
 *   - Chiptune sources persist as their tiny `ChiptuneParams` JSON; the
 *     synth is deterministic so re-running it reproduces the int8 exactly.
 *   - Sampler sources persist as 16-bit PCM WAV bytes (base64). 16-bit is
 *     well above the int8 PT quantizer downstream, so storing wider buys
 *     no audible quality. They're heavy — large enough that an autosave
 *     can blow the localStorage quota; saveSession then stores the
 *     session without them and reports "degraded" so the App can warn.
 *
 * Other things we don't persist:
 *   - History stacks — a fresh session starts with no undo, matching the
 *     "Open .mod" path which also calls clearHistory.
 *   - Selection / clipboard — ephemeral.
 *   - Transport / playPos — playback never resumes mid-stream.
 *
 * Schema versions: the storage key is `retrotracker:session:v1` (kept for
 * backward compat with already-saved sessions). The `v` field bumped to 2
 * when chiptuneSources was added, then to 3 for samplerSources. Older
 * payloads still load (without the missing maps); newer writes use the
 * lowest version that fits the data so a project that uses neither field
 * stays bit-identical to the original v=1 format.
 */

const STORAGE_KEY = "retrotracker:session:v1";

type SchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * On-disk shape for one persisted sampler source. The whole sampler-side
 * workbench (source + chain + PT) round-trips so a refresh restores the
 * pipeline exactly as the user left it. The `alt` stash is intentionally
 * dropped — that's session-only.
 *
 * `chain` and `pt` are optional so older v=3 payloads (saved before the
 * chain started persisting) still load — they restore with an empty chain
 * and default PT params.
 */
interface PersistedSamplerSource {
  /** Display name shown in the pipeline header. */
  sourceName: string;
  /**
   * 16-bit PCM WAV file bytes, base64-encoded. Round-trips through
   * `writeWav` / `readWav` so the format is self-describing — sample rate
   * and channel count are recoverable from the chunk headers without
   * inventing a parallel JSON shape. Present in `.retro` files and in
   * autosaves written without a source store.
   */
  wavBase64?: string;
  /**
   * Autosave only: id of the same WAV bytes in the source store
   * (IndexedDB — see state/sourceStore.ts). Used instead of `wavBase64`
   * so the localStorage payload stays small. Never written to `.retro`.
   */
  wavRef?: string;
  /** Effect chain in original order. Optional for back-compat. */
  chain?: EffectNode[];
  /** PT transformer params (mono mix + target note). Optional for back-compat. */
  pt?: PtTransformerParams;
}

/**
 * On-disk shape for one XM sampler workbench. Mirrors `PersistedSamplerSource`
 * but with the XM transformer (`monoMix` + `bitDepth` + optional `dither`)
 * instead of PT's. Stored under a composite key `"inst1Based:sampleIdx"`
 * so multi-sample instruments round-trip per-sample. The `alt` stash is
 * intentionally dropped — session-only state, same as PT2.
 */
interface PersistedXmSamplerSource {
  sourceName: string;
  /** See `PersistedSamplerSource` — one of the two is present. */
  wavBase64?: string;
  wavRef?: string;
  chain?: EffectNode[];
  xm?: XmTransformerParams;
}

/**
 * On-disk shape for one XM chiptune workbench. The chain + transformer
 * params persist alongside the synth params so a chiptune slot with
 * effects round-trips, not just the synth.
 */
interface PersistedXmChiptuneSource {
  params: ChiptuneParams;
  chain?: EffectNode[];
  xm?: XmTransformerParams;
}

interface PersistedShape {
  v: SchemaVersion;
  /**
   * v≥9 only: which tracker format the embedded song is. Older payloads
   * silently treat the song as PT2 — the field is absent on disk and the
   * loader fills it in.
   */
  format?: "PT2" | "FT2";
  songBase64: string;
  filename: string | null;
  /** Optional in v=1: older snapshots predate the Info view and load with ''. */
  infoText?: string;
  view: View;
  cursor: Cursor;
  currentSample: number;
  currentOctave: number;
  editStep: number;
  /**
   * v≥2 only: per-slot chiptune source params. Slot index → params.
   * Optional so v=1 payloads still validate.
   */
  chiptuneSources?: Record<number, ChiptuneParams>;
  /**
   * v≥3 only: per-slot sampler source WAVs. Slot index → encoded source.
   * Optional so v<3 payloads still validate.
   */
  samplerSources?: Record<number, PersistedSamplerSource>;
  /**
   * v≥4 only: user-given pattern names (project-only — never written to the
   * exported `.mod`). Key is the 0-based pattern index. Optional so v<4
   * payloads still validate.
   */
  patternNames?: Record<number, string>;
  /**
   * v≥5 only: per-channel mute/solo flags as 4-element boolean arrays.
   * Optional so v<5 payloads still validate. Stored only when at least
   * one channel is muted or solo'd — an all-false snapshot is the
   * default and keeps the payload bit-identical to a v<5 reader.
   */
  mutedChannels?: boolean[];
  soloedChannels?: boolean[];
  /**
   * Per-(instrument, sample) sampler workbenches for XM projects. Key
   * format is the string `"inst1Based:sampleIdx"` (mirroring the in-
   * memory `XmWorkbenchKey`). Absent on PT2 projects. Optional so older
   * payloads still validate; readers without XM support ignore the
   * field.
   */
  xmSamplerSources?: Record<string, PersistedXmSamplerSource>;
  /** Per-(instrument, sample) chiptune workbenches for XM projects. */
  xmChiptuneSources?: Record<string, PersistedXmChiptuneSource>;
  /**
   * Cloud origin of the persisted song, if any. Mirrors the in-memory
   * `cloudOrigin` signal in session.ts. Absent when the song was never
   * loaded from / saved to the cloud — readers treat absence as null.
   * Backward-compatible: pre-feature payloads simply lack the field.
   */
  cloudOrigin?: { resource: "projects" | "modules"; name: string };
}

/**
 * Input shape for one sampler workbench the App wants to persist. The App
 * owns `WavData`; the persistence layer encodes it to bytes (via `writeWav`)
 * and base64s the result. Keeping the encoding inside this module means
 * callers never touch base64 / RIFF directly.
 *
 * `chain` and `pt` round-trip alongside the source so the pipeline UI
 * restores exactly as left — not just the source name.
 */
export interface SamplerSourceInputs {
  sourceName: string;
  wav: WavData;
  chain: EffectNode[];
  pt: PtTransformerParams;
}

/**
 * Caller-facing input for one XM sampler workbench. Same idea as
 * `SamplerSourceInputs` but with the XM-side transformer params.
 */
export interface XmSamplerSourceInputs {
  sourceName: string;
  wav: WavData;
  chain: EffectNode[];
  xm: XmTransformerParams;
}

/** Caller-facing input for one XM chiptune workbench. */
export interface XmChiptuneSourceInputs {
  params: ChiptuneParams;
  chain: EffectNode[];
  xm: XmTransformerParams;
}

export interface SessionInputs {
  /**
   * Song to persist. The `format` discriminator picks the right writer:
   * PT2 → writeModule, FT2 → writeXm. The two share `songBase64` on disk
   * because the reader sniffs the format field (v=9+) before parsing.
   */
  song: Song;
  filename: string | null;
  /** Optional — defaults to '' when omitted. */
  infoText?: string;
  view: View;
  cursor: Cursor;
  currentSample: number;
  currentOctave: number;
  editStep: number;
  /** Per-slot chiptune source params (slot index → params). Optional. */
  chiptuneSources?: Record<number, ChiptuneParams>;
  /** Per-slot sampler source WAVs (slot index → source). Optional. */
  samplerSources?: Record<number, SamplerSourceInputs>;
  /** Project-only pattern names (pattern index → name). Optional. */
  patternNames?: Record<number, string>;
  /**
   * Per-channel mute / solo state (4-element boolean arrays). Optional;
   * an all-false snapshot is omitted from the payload so a project that
   * never touches the mute toggles stays bit-identical to its older
   * pre-mute persistence.
   */
  mutedChannels?: readonly boolean[];
  soloedChannels?: readonly boolean[];
  /**
   * XM workbenches keyed by `"inst1Based:sampleIdx"`. Split into sampler
   * and chiptune halves to mirror PT2's `chiptuneSources` /
   * `samplerSources` split — a single workbench appears in exactly one
   * of the two maps based on its active source kind.
   */
  xmSamplerSources?: Record<string, XmSamplerSourceInputs>;
  xmChiptuneSources?: Record<string, XmChiptuneSourceInputs>;
  /**
   * The cloud bucket + path the song lives at (set after a successful
   * cloud open or cloud save). Persisted alongside the song so a page
   * refresh keeps "Share this song" enabled — without it, the user
   * loses share access every time they reload and has to re-save to
   * regenerate the origin. Omitted from the payload when null.
   *
   * Shape inlined (instead of importing `CloudOrigin` from session.ts)
   * to avoid a runtime import cycle — the structural type is small
   * enough that duplication doesn't hurt.
   */
  cloudOrigin?: { resource: "projects" | "modules"; name: string } | null;
}

/** A session that has been read back: same shape as SessionInputs, but
 *  `infoText` is always materialised (never undefined) so the App can
 *  `setInfoText` without a fallback at every call site. */
export type LoadedSession = Omit<
  SessionInputs,
  | "infoText"
  | "chiptuneSources"
  | "samplerSources"
  | "patternNames"
  | "mutedChannels"
  | "soloedChannels"
  | "xmSamplerSources"
  | "xmChiptuneSources"
> & {
  infoText: string;
  /** Always materialised on load — empty record when none persisted. */
  chiptuneSources: Record<number, ChiptuneParams>;
  /** Always materialised on load — empty record when none persisted. */
  samplerSources: Record<number, SamplerSourceInputs>;
  /** Always materialised on load — empty record when none persisted. */
  patternNames: Record<number, string>;
  /** Always materialised on load — 4-element all-false array when none persisted. */
  mutedChannels: boolean[];
  soloedChannels: boolean[];
  /** Always materialised on load — empty record when none persisted. */
  xmSamplerSources: Record<string, XmSamplerSourceInputs>;
  xmChiptuneSources: Record<string, XmChiptuneSourceInputs>;
  /** Cloud origin if the persisted payload had one, else `null`. */
  cloudOrigin: { resource: "projects" | "modules"; name: string } | null;
  /**
   * Sampler sources whose audio lives in the source store rather than
   * inline. The loader can't fetch them synchronously, so they are
   * handed back un-resolved; `resolvePendingSources` turns them into
   * the same shape as `samplerSources` / `xmSamplerSources`. Always
   * empty for `.retro` files.
   */
  pendingSources: PendingSource[];
};

/** One sampler source awaiting its audio from the source store. */
export type PendingSource =
  | {
      kind: "pt";
      slot: number;
      ref: string;
      sourceName: string;
      /** Parsed but not yet sentinel-fixed — that needs the audio. */
      chain: EffectNode[];
      pt: PtTransformerParams;
    }
  | {
      kind: "xm";
      key: string;
      ref: string;
      sourceName: string;
      chain: EffectNode[];
      xm: XmTransformerParams;
    };

function bytesToBase64(bytes: Uint8Array): string {
  // The CharCode-loop / btoa pair is the smallest reliable Uint8Array→base64
  // path in browsers without TextDecoder hijinks. We chunk to avoid the
  // String.fromCharCode argument-list cap (~64KB on V8). A typical .mod
  // sits under that anyway, but big sample data can push past.
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(out);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Cached base64 encoding of the most recently encoded ModSong. The autosave
 * effect fires on every cursor move / view toggle / current-sample change,
 * but the song itself rarely changes between those firings. Re-running
 * writeModule + base64 on a 16-pattern song with samples is ~10–50 ms of
 * synchronous work; reusing the cached string when `state.song === lastSong`
 * keeps a Cmd+S / autosave roundtrip in the sub-millisecond range.
 *
 * We compare by reference because every commit produces a new ModSong —
 * `commitEdit` builds the new song immutably, so reference equality is a
 * sound proxy for "song unchanged". A direct `setSong` from outside the
 * commit path would invalidate the cache the moment it's called.
 */
let lastSong: Song | null = null;
let lastBase64: string | null = null;

function encodeSongCached(song: Song): string {
  if (lastSong === song && lastBase64 !== null) return lastBase64;
  const b64 = bytesToBase64(
    song.format === "PT2" ? writeModule(song) : writeXm(song),
  );
  lastSong = song;
  lastBase64 = b64;
  return b64;
}

/** Build the on-the-wire payload — song goes through writeModule + base64
 *  so we re-use the lossless M.K. binary instead of inventing a JSON shape
 *  for the sample data.  Throws if `writeModule` rejects the song. */
function buildPayload(
  state: SessionInputs,
  /** When given, sampler audio is written as a store reference instead
   *  of inline base64. Autosave-with-store only. */
  refFor?: (wav: WavData) => string,
): PersistedShape {
  const hasChiptune =
    !!state.chiptuneSources && Object.keys(state.chiptuneSources).length > 0;
  const hasSampler =
    !!state.samplerSources && Object.keys(state.samplerSources).length > 0;
  const hasPatternNames =
    !!state.patternNames && Object.keys(state.patternNames).length > 0;
  const hasMute =
    (state.mutedChannels?.some((b) => b) ?? false) ||
    (state.soloedChannels?.some((b) => b) ?? false);
  // v=6 is required when any sampler chain has a `volume` envelope —
  // older readers parse `volume` as an unknown effect kind and silently
  // drop it, which would lose the user's amplitude shaping.
  const hasVolumeEnvelope =
    !!state.samplerSources &&
    Object.values(state.samplerSources).some((s) =>
      s.chain.some((n) => n.kind === "volume"),
    );
  // v=7 is required when any sampler chain has a filter or shaper node:
  // those now carry envelope-shaped params (`cutoff` / `q` / `amount`
  // arrays) instead of single numbers. A v≤6 reader expects the old
  // single-number shape; arrays make `parseEffectNode` reject the node
  // and silently drop it, which would lose the user's filter / shaper.
  const hasFilterOrShaper =
    !!state.samplerSources &&
    Object.values(state.samplerSources).some((s) =>
      s.chain.some((n) => n.kind === "filter" || n.kind === "shaper"),
    );
  // v=8 is required when any sampler chain has a `pitch` node. The
  // pitch effect is new in v=8 — v≤7 readers don't recognise the kind
  // and would silently drop the node, losing the user's automation.
  const hasPitch =
    !!state.samplerSources &&
    Object.values(state.samplerSources).some((s) =>
      s.chain.some((n) => n.kind === "pitch"),
    );
  const hasXmSampler =
    !!state.xmSamplerSources && Object.keys(state.xmSamplerSources).length > 0;
  const hasXmChiptune =
    !!state.xmChiptuneSources &&
    Object.keys(state.xmChiptuneSources).length > 0;
  // Once XM landed (v=9), every new write stamps the current version: the
  // `format` discriminator was added unconditionally and older readers
  // shouldn't be guessing it. Older builds (pre-XM) will refuse to load
  // these files; that's the user-confirmed trade-off.
  void hasPitch;
  void hasFilterOrShaper;
  void hasVolumeEnvelope;
  void hasMute;
  void hasPatternNames;
  void hasSampler;
  void hasChiptune;
  const v: SchemaVersion = 9;
  return {
    v,
    format: state.song.format,
    songBase64: encodeSongCached(state.song),
    filename: state.filename,
    infoText: state.infoText ?? "",
    view: state.view,
    cursor: state.cursor,
    currentSample: state.currentSample,
    currentOctave: state.currentOctave,
    editStep: state.editStep,
    ...(hasChiptune ? { chiptuneSources: state.chiptuneSources } : {}),
    ...(hasSampler
      ? {
          samplerSources: encodeSamplerSources(state.samplerSources!, refFor),
        }
      : {}),
    ...(hasPatternNames ? { patternNames: state.patternNames } : {}),
    ...(hasMute
      ? {
          mutedChannels: muteSnapshot(state.mutedChannels),
          soloedChannels: muteSnapshot(state.soloedChannels),
        }
      : {}),
    ...(hasXmSampler
      ? {
          xmSamplerSources: encodeXmSamplerSources(
            state.xmSamplerSources!,
            refFor,
          ),
        }
      : {}),
    ...(hasXmChiptune
      ? { xmChiptuneSources: encodeXmChiptuneSources(state.xmChiptuneSources!) }
      : {}),
    ...(state.cloudOrigin ? { cloudOrigin: state.cloudOrigin } : {}),
  };
}

/** Coerce a possibly-undefined mute/solo array to a clean boolean array.
 *  At least 4 entries (the PT shape older readers expect), and as many
 *  as the input carries up to the FT2 channel cap — a fixed 4 used to
 *  drop the flags of channels 5+ on every FT2 save. Used at write time
 *  so the payload never contains stray undefineds; parsers do the same
 *  on read for symmetry. */
function muteSnapshot(xs: readonly boolean[] | undefined): boolean[] {
  const n = Array.isArray(xs) ? xs.length : 0;
  const length = Math.max(CHANNELS, Math.min(XM_MAX_CHANNELS, n));
  return Array.from({ length }, (_, i) => xs?.[i] === true);
}

/**
 * Base64 of each sampler source's 16-bit WAV encoding, keyed by the
 * `WavData` object. Source audio is by far the largest part of a
 * project, and both the header's size estimate (recomputed on every
 * song / workbench change) and the autosave re-encoded ALL of it each
 * time — ~130 ms per keystroke with one 30-second stereo source.
 *
 * Keying by reference is sound for the same reason `encodeSongCached`
 * is: a workbench source's `WavData` is never mutated in place — every
 * op that changes the audio (load, paste, apply-chain) builds a new one.
 * WeakMap, so an entry dies with its source.
 */
const wavBase64Cache = new WeakMap<WavData, string>();

function encodeWavCached(wav: WavData): string {
  const hit = wavBase64Cache.get(wav);
  if (hit !== undefined) return hit;
  const b64 = bytesToBase64(writeWav(wav, { bitsPerSample: 16 }));
  wavBase64Cache.set(wav, b64);
  return b64;
}

/** Encode each sampler source's WavData as 16-bit PCM bytes → base64,
 *  alongside the chain + PT params. Slot keys are preserved verbatim
 *  (numeric strings) so the JSON map parses back symmetrically. */
function encodeSamplerSources(
  src: Record<number, SamplerSourceInputs>,
  refFor?: (wav: WavData) => string,
): Record<number, PersistedSamplerSource> {
  const out: Record<number, PersistedSamplerSource> = {};
  for (const [k, v] of Object.entries(src)) {
    out[Number(k)] = {
      sourceName: v.sourceName,
      ...(refFor
        ? { wavRef: refFor(v.wav) }
        : { wavBase64: encodeWavCached(v.wav) }),
      ...(v.chain.length > 0 ? { chain: v.chain } : {}),
      pt: v.pt,
    };
  }
  return out;
}

/** XM counterpart of `encodeSamplerSources`. Keys are composite
 *  `"inst1Based:sampleIdx"` strings so multi-sample instruments round-
 *  trip per-sample. */
function encodeXmSamplerSources(
  src: Record<string, XmSamplerSourceInputs>,
  refFor?: (wav: WavData) => string,
): Record<string, PersistedXmSamplerSource> {
  const out: Record<string, PersistedXmSamplerSource> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = {
      sourceName: v.sourceName,
      ...(refFor
        ? { wavRef: refFor(v.wav) }
        : { wavBase64: encodeWavCached(v.wav) }),
      ...(v.chain.length > 0 ? { chain: v.chain } : {}),
      xm: v.xm,
    };
  }
  return out;
}

function encodeXmChiptuneSources(
  src: Record<string, XmChiptuneSourceInputs>,
): Record<string, PersistedXmChiptuneSource> {
  const out: Record<string, PersistedXmChiptuneSource> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = {
      params: v.params,
      ...(v.chain.length > 0 ? { chain: v.chain } : {}),
      xm: v.xm,
    };
  }
  return out;
}

/** Decode a (presumed) PersistedShape back to a LoadedSession. Returns
 *  null on any shape / parse failure. Shared by localStorage and the
 *  `.retro` file-import path so they validate identically. */
function payloadToSession(parsed: unknown): LoadedSession | null {
  if (!isPersistedShape(parsed)) return null;
  // The `format` discriminator is v=9+; older payloads predate XM and
  // are always PT2 — fall through to writeModule's parser. v=9 still
  // round-trips PT2 fine (the field is set explicitly there).
  const format: "PT2" | "FT2" = parsed.format === "FT2" ? "FT2" : "PT2";
  let song: Song;
  try {
    const bytes = base64ToBytes(parsed.songBase64);
    if (format === "FT2") {
      song = parseXm(bytes.buffer as ArrayBuffer) as XmSong;
    } else {
      song = parseModule(bytes.buffer);
    }
  } catch {
    return null;
  }
  return {
    song,
    filename: parsed.filename ?? null,
    infoText: typeof parsed.infoText === "string" ? parsed.infoText : "",
    view:
      parsed.view === "sample"
        ? "sample"
        : parsed.view === "info"
          ? "info"
          : parsed.view === "settings"
            ? "settings"
            : "pattern",
    cursor: sanitiseCursor(parsed.cursor, format),
    currentSample: clamp(parsed.currentSample, 1, 31, 1),
    currentOctave: clamp(parsed.currentOctave, 1, 3, 2),
    editStep: clamp(parsed.editStep, 0, 16, 1),
    chiptuneSources: parseChiptuneSources(parsed.chiptuneSources),
    samplerSources: parseSamplerSources(parsed.samplerSources),
    patternNames: parsePatternNames(parsed.patternNames),
    mutedChannels: muteSnapshot(parsed.mutedChannels as boolean[] | undefined),
    soloedChannels: muteSnapshot(
      parsed.soloedChannels as boolean[] | undefined,
    ),
    xmSamplerSources: parseXmSamplerSources(parsed.xmSamplerSources),
    xmChiptuneSources: parseXmChiptuneSources(parsed.xmChiptuneSources),
    cloudOrigin: parseCloudOrigin(parsed.cloudOrigin),
    pendingSources: [
      ...parsePendingSources(parsed.samplerSources, "pt"),
      ...parsePendingSources(parsed.xmSamplerSources, "xm"),
    ],
  };
}

/** Ids we hand out are UUIDs; accept anything of that general shape so a
 *  hand-edited payload can't smuggle an odd key into the store lookup. */
const SOURCE_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Collect the entries of a sampler-source map that reference the source
 * store (`wavRef`) instead of carrying audio inline. Inline entries are
 * handled by `parseSamplerSources` / `parseXmSamplerSources`; an entry
 * with both is treated as inline. Validation mirrors those parsers.
 */
function parsePendingSources(raw: unknown, kind: "pt" | "xm"): PendingSource[] {
  if (!raw || typeof raw !== "object") return [];
  const out: PendingSource[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    if (typeof entry["wavBase64"] === "string" && entry["wavBase64"]) continue;
    const ref = entry["wavRef"];
    if (typeof ref !== "string" || !SOURCE_REF_RE.test(ref)) continue;
    const sourceName =
      typeof entry["sourceName"] === "string" ? entry["sourceName"] : "";
    const chain = parseEffectChain(entry["chain"]);
    if (kind === "pt") {
      const slot = parseInt(k, 10);
      if (!Number.isFinite(slot) || slot < 0 || slot > 30) continue;
      out.push({
        kind,
        slot,
        ref,
        sourceName,
        chain,
        pt: parsePtParams(entry["pt"]),
      });
    } else {
      if (!isXmWorkbenchKey(k)) continue;
      out.push({
        kind,
        key: k,
        ref,
        sourceName,
        chain,
        xm: parseXmTransformer(entry["xm"]),
      });
    }
  }
  return out;
}

/** Defensive cast for the persisted `cloudOrigin` field — rejects anything
 *  that isn't the exact `{resource, name}` shape with allowed enum values.
 *  Treating malformed values as "no origin" keeps a botched payload from
 *  silently enabling Share against a phantom file. */
function parseCloudOrigin(
  v: unknown,
): { resource: "projects" | "modules"; name: string } | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  if (o.resource !== "projects" && o.resource !== "modules") return null;
  return { resource: o.resource, name: o.name };
}

/**
 * Replace any `SENTINEL_RIGHT_FRAME` (-1) markers left by the legacy
 * `gain → volume` migration with the actual right-edge frame of the chain
 * stage that effect runs against. Walks the chain partially: for each
 * volume node at index i, the input length is the output of `chain[0..i)`
 * applied to the source — so a `crop` placed before the migrated gain
 * yields a sensibly-sized envelope, not the full source length.
 *
 * No-op for chains without sentinels (the common case for v=6+ projects).
 */
function fixupSentinelFrames(
  chain: EffectNode[],
  wav: WavData,
  sourceName: string,
): EffectNode[] {
  const hasSentinelInPoints = (pts: ReadonlyArray<EnvelopePoint>): boolean =>
    pts.some((p) => p.frame === SENTINEL_RIGHT_FRAME);
  const hasSentinel = chain.some((n) => {
    if (n.kind === "volume") return hasSentinelInPoints(n.params.points);
    if (n.kind === "filter")
      return (
        hasSentinelInPoints(n.params.cutoff) || hasSentinelInPoints(n.params.q)
      );
    if (n.kind === "shaper") return hasSentinelInPoints(n.params.amount);
    if (n.kind === "pitch") return hasSentinelInPoints(n.params.envelope);
    return false;
  });
  if (!hasSentinel) return chain;
  const source = materializeSource({ kind: "sampler", wav, sourceName });
  const out: EffectNode[] = [];
  let stageInput: WavData = source;
  const fixPoints = (
    pts: ReadonlyArray<EnvelopePoint>,
    lastFrame: number,
  ): ReadonlyArray<EnvelopePoint> =>
    pts.map((p) =>
      p.frame === SENTINEL_RIGHT_FRAME ? { ...p, frame: lastFrame } : p,
    );
  for (const node of chain) {
    const stageLen = stageInput.channels[0]?.length ?? 0;
    const lastFrame = Math.max(0, stageLen - 1);
    if (node.kind === "volume") {
      out.push({
        kind: "volume",
        params: { points: fixPoints(node.params.points, lastFrame) },
      });
    } else if (node.kind === "filter") {
      out.push({
        kind: "filter",
        params: {
          type: node.params.type,
          cutoff: fixPoints(node.params.cutoff, lastFrame),
          q: fixPoints(node.params.q, lastFrame),
        },
      });
    } else if (node.kind === "shaper") {
      out.push({
        kind: "shaper",
        params: {
          mode: node.params.mode,
          amount: fixPoints(node.params.amount, lastFrame),
        },
      });
    } else if (node.kind === "pitch") {
      out.push({
        kind: "pitch",
        params: {
          envelope: fixPoints(node.params.envelope, lastFrame),
        },
      });
    } else {
      out.push(node);
    }
    // Advance the stage input by running this node — `runChain` with a
    // single-element list does the dispatch for us. No RunContext: we
    // don't have the slot's loop info at parse time, so loop-aware
    // effects (crossfade) get a pass-through approximation here. The
    // sentinels only matter for envelope-bearing nodes, which we've
    // already replaced above.
    stageInput = runChain(stageInput, [out[out.length - 1]!]);
  }
  return out;
}

/**
 * Validate a `samplerSources` map. Each entry must have a string sourceName
 * and a base64 WAV payload that `readWav` accepts; bad entries are silently
 * dropped (better than failing the whole load over a single corrupt slot).
 * Slot indices are clamped to [0, 30] — anything outside can't refer to a
 * real PT sample slot.
 *
 * Chain + PT are optional in the on-disk shape (older v=3 payloads predate
 * them); when missing, they default to an empty chain and the standard PT
 * params (`average` mono mix, C-2 target note).
 */
function parseSamplerSources(
  raw: unknown,
): Record<number, SamplerSourceInputs> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<number, SamplerSourceInputs> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const slot = parseInt(k, 10);
    if (!Number.isFinite(slot) || slot < 0 || slot > 30) continue;
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    const sourceName =
      typeof entry["sourceName"] === "string" ? entry["sourceName"] : "";
    const wavBase64 =
      typeof entry["wavBase64"] === "string" ? entry["wavBase64"] : null;
    if (!wavBase64) continue;
    try {
      const wav = readWav(base64ToBytes(wavBase64));
      const chain = parseEffectChain(entry["chain"]);
      out[slot] = {
        sourceName,
        wav,
        chain: fixupSentinelFrames(chain, wav, sourceName),
        pt: parsePtParams(entry["pt"]),
      };
    } catch {
      // Corrupt WAV bytes — drop this slot and continue.
    }
  }
  return out;
}

/** XM counterpart of `parseSamplerSources`. Keys are validated as
 *  `"inst:sampleIdx"` composites with inst in [1, 128] and sampleIdx in
 *  [0, 15]; malformed entries are dropped silently. */
function parseXmSamplerSources(
  raw: unknown,
): Record<string, XmSamplerSourceInputs> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, XmSamplerSourceInputs> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isXmWorkbenchKey(k)) continue;
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    const sourceName =
      typeof entry["sourceName"] === "string" ? entry["sourceName"] : "";
    const wavBase64 =
      typeof entry["wavBase64"] === "string" ? entry["wavBase64"] : null;
    if (!wavBase64) continue;
    try {
      const wav = readWav(base64ToBytes(wavBase64));
      const chain = parseEffectChain(entry["chain"]);
      out[k] = {
        sourceName,
        wav,
        chain: fixupSentinelFrames(chain, wav, sourceName),
        xm: parseXmTransformer(entry["xm"]),
      };
    } catch {
      // Corrupt WAV bytes — drop this slot and continue.
    }
  }
  return out;
}

function parseXmChiptuneSources(
  raw: unknown,
): Record<string, XmChiptuneSourceInputs> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, XmChiptuneSourceInputs> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isXmWorkbenchKey(k)) continue;
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    const params = chiptuneFromJson(entry["params"]);
    if (!params) continue;
    out[k] = {
      params,
      chain: parseEffectChain(entry["chain"]),
      xm: parseXmTransformer(entry["xm"]),
    };
  }
  return out;
}

/** "inst:sampleIdx" where inst ∈ [1, 128], sampleIdx ∈ [0, 15]. */
function isXmWorkbenchKey(k: string): boolean {
  const parts = k.split(":");
  if (parts.length !== 2) return false;
  const inst = parseInt(parts[0]!, 10);
  const idx = parseInt(parts[1]!, 10);
  if (!Number.isFinite(inst) || inst < 1 || inst > 128) return false;
  if (!Number.isFinite(idx) || idx < 0 || idx > 15) return false;
  return true;
}

/** Validate XM transformer params. Falls back to defaults on anything
 *  malformed so a corrupt `xm` block doesn't lose the whole workbench. */
function parseXmTransformer(raw: unknown): XmTransformerParams {
  const fallback: XmTransformerParams = { monoMix: "average", bitDepth: 8 };
  if (!raw || typeof raw !== "object") return fallback;
  const x = raw as Record<string, unknown>;
  const mix = x["monoMix"];
  const monoMix: MonoMix =
    mix === "left" ? "left" : mix === "right" ? "right" : "average";
  const bd = x["bitDepth"];
  const bitDepth: 8 | 16 = bd === 16 ? 16 : 8;
  const dither = x["dither"] === true;
  return dither ? { monoMix, bitDepth, dither: true } : { monoMix, bitDepth };
}

/** Parse an `EffectNode[]` from an unknown JSON value. Drops bad entries
 *  rather than failing — a single corrupt effect shouldn't lose the chain. */
function parseEffectChain(raw: unknown): EffectNode[] {
  if (!Array.isArray(raw)) return [];
  const out: EffectNode[] = [];
  for (const v of raw) {
    const node = parseEffectNode(v);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Sentinel "right edge" frame used during gain → volume migration: at
 * parse time we don't know the chain output length yet, so the second
 * point gets `frame: SENTINEL_RIGHT_FRAME` and `parseSamplerSources`
 * fixes it up after running the chain. Any value < 0 works as a marker;
 * choose -1 specifically so a stray un-fixed sentinel still sorts to the
 * front (where it would clamp the envelope to its gain).
 */
const SENTINEL_RIGHT_FRAME = -1;

function clampValueForParam(v: number, param: EnvelopeParamKey): number {
  const axis = PARAM_AXES[param];
  return Math.max(axis.min, Math.min(axis.max, v));
}

/** Parse a single envelope-point JSON entry. Reads `value` first, falls
 *  back to `gain` for compat with the brief v=6 window where the field
 *  was named `gain`. Frames are floored to non-negative integers, except
 *  the SENTINEL_RIGHT_FRAME which passes through for the loader fixup. */
function parseEnvelopePoint(
  raw: unknown,
  param: EnvelopeParamKey,
): EnvelopePoint | null {
  if (!raw || typeof raw !== "object") return null;
  const pt = raw as Record<string, unknown>;
  if (typeof pt["frame"] !== "number") return null;
  const v = pt["value"];
  const g = pt["gain"];
  const value =
    typeof v === "number" ? v : typeof g === "number" ? g : undefined;
  if (value === undefined) return null;
  const f = pt["frame"];
  const frame =
    f === SENTINEL_RIGHT_FRAME
      ? SENTINEL_RIGHT_FRAME
      : Math.max(0, Math.floor(f));
  return { frame, value: clampValueForParam(value, param) };
}

/**
 * Parse an envelope param that may be either a legacy single number
 * (pre-envelope filter / shaper, pre-v=7) or an envelope array. Single
 * numbers become 2-point flat envelopes with the right endpoint
 * sentinel'd for the chain-stage fixup. Returns null on malformed input.
 */
function parseEnvelopeOrSingle(
  raw: unknown,
  param: EnvelopeParamKey,
): EnvelopePoint[] | null {
  if (typeof raw === "number") {
    const value = clampValueForParam(raw, param);
    return [
      { frame: 0, value },
      { frame: SENTINEL_RIGHT_FRAME, value },
    ];
  }
  if (!Array.isArray(raw) || raw.length < ENVELOPE_MIN_POINTS) return null;
  const points: EnvelopePoint[] = [];
  for (const entry of raw) {
    const pt = parseEnvelopePoint(entry, param);
    if (!pt) return null;
    points.push(pt);
  }
  // Sort but keep sentinel frames at their position (sentinel sorts first
  // since -1 < everything; the loader replaces it with the actual right
  // edge before it ever feeds the runtime).
  points.sort((a, b) => a.frame - b.frame);
  return points;
}

/** Validate one EffectNode. Returns null on any structural mismatch.
 *
 *  Legacy migration: old `gain` / `fadeIn` / `fadeOut` kinds (pre-v=6) are
 *  rewritten as equivalent `volume` envelopes here. The migration is
 *  best-effort — a fadeIn / fadeOut over [s, e) doesn't have an exact
 *  representation as a clamp-to-boundary envelope without a 1-frame
 *  artificial drop, so the migrated envelope can disagree with the old
 *  effect by ≤ 1 frame at the boundary. Practically inaudible.
 *
 *  After parsing the kind-specific fields, a top-level `bypassed: true`
 *  on the raw payload is attached to the node so the user's bypass
 *  toggle survives a save/load. Other truthy values (or absence)
 *  produce no `bypassed` field at all (the type's `bypassed?: boolean`
 *  default of "not bypassed" stands). */
function parseEffectNode(v: unknown): EffectNode | null {
  const node = parseEffectNodeInner(v);
  if (!node) return null;
  if (
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>)["bypassed"] === true
  ) {
    return { ...node, bypassed: true };
  }
  return node;
}

function parseEffectNodeInner(v: unknown): EffectNode | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const kind = x["kind"];
  if (kind === "normalize") return { kind: "normalize" };
  const p = x["params"];
  if (!p || typeof p !== "object") return null;
  const params = p as Record<string, unknown>;
  // Legacy `gain` → 2-point flat envelope. The right point's frame is
  // sentinel'd because parse-time has no chain length yet; the
  // sampler-source loader replaces it with the actual last frame.
  if (kind === "gain") {
    if (typeof params["gain"] !== "number") return null;
    const value = clampValueForParam(params["gain"], "volume");
    return {
      kind: "volume",
      params: {
        points: [
          { frame: 0, value },
          { frame: SENTINEL_RIGHT_FRAME, value },
        ],
      },
    };
  }
  // Legacy `fadeIn` over [s, e): three-or-four-point ramp, with padding
  // so frames 0..s-1 stay at gain 1 (matches the old pass-through
  // outside-range semantic). When s === 0 the ramp starts at frame 0,
  // dropping the leading padding.
  if (kind === "fadeIn") {
    if (
      typeof params["startFrame"] !== "number" ||
      typeof params["endFrame"] !== "number"
    )
      return null;
    const s = Math.max(0, Math.floor(params["startFrame"]));
    const e = Math.max(s, Math.floor(params["endFrame"]));
    const points: EnvelopePoint[] =
      s === 0
        ? [
            { frame: 0, value: 0 },
            { frame: e, value: 1 },
          ]
        : [
            { frame: 0, value: 1 },
            { frame: Math.max(0, s - 1), value: 1 },
            { frame: s, value: 0 },
            { frame: e, value: 1 },
          ];
    return { kind: "volume", params: { points } };
  }
  // Legacy `fadeOut` over [s, e): drop to 0 at e, jump back to 1 at e+1
  // so frames after the fade ramp pass through at full volume (clamp
  // semantics: rightmost gain extends rightward).
  if (kind === "fadeOut") {
    if (
      typeof params["startFrame"] !== "number" ||
      typeof params["endFrame"] !== "number"
    )
      return null;
    const s = Math.max(0, Math.floor(params["startFrame"]));
    const e = Math.max(s, Math.floor(params["endFrame"]));
    return {
      kind: "volume",
      params: {
        points: [
          { frame: s, value: 1 },
          { frame: e, value: 0 },
          { frame: e + 1, value: 1 },
        ],
      },
    };
  }
  if (kind === "volume") {
    const points = parseEnvelopeOrSingle(params["points"], "volume");
    if (!points) return null;
    return { kind: "volume", params: { points } };
  }
  if (kind === "reverse" || kind === "crop" || kind === "cut") {
    if (typeof params["startFrame"] !== "number") return null;
    if (typeof params["endFrame"] !== "number") return null;
    return {
      kind,
      params: {
        startFrame: Math.max(0, Math.floor(params["startFrame"])),
        endFrame: Math.max(0, Math.floor(params["endFrame"])),
      },
    };
  }
  if (kind === "filter") {
    const type = params["type"];
    if (type !== "lowpass" && type !== "highpass") return null;
    // Both legacy single-number and new envelope-array forms are
    // accepted by `parseEnvelopeOrSingle` — pre-v=7 payloads stored
    // `cutoff` / `q` as scalars, those load as 2-point flat envelopes
    // with a SENTINEL_RIGHT_FRAME on the right edge that the sampler
    // loader fixes up to the chain stage's actual last frame.
    const cutoff = parseEnvelopeOrSingle(params["cutoff"], "cutoff");
    const q = parseEnvelopeOrSingle(params["q"], "q");
    if (!cutoff || !q) return null;
    return { kind: "filter", params: { type, cutoff, q } };
  }
  if (kind === "crossfade") {
    if (typeof params["length"] !== "number") return null;
    return {
      kind: "crossfade",
      params: { length: Math.max(1, Math.floor(params["length"])) },
    };
  }
  if (kind === "shaper") {
    const mode = params["mode"];
    if (
      typeof mode !== "string" ||
      !(SHAPER_MODES as readonly string[]).includes(mode)
    )
      return null;
    // Same dual-shape acceptance as filter: pre-v=7 stored a single
    // number, v=7+ stores an envelope array.
    const amount = parseEnvelopeOrSingle(params["amount"], "amount");
    if (!amount) return null;
    return { kind: "shaper", params: { mode: mode as ShaperMode, amount } };
  }
  if (kind === "pitch") {
    // v=8+. There's no pre-envelope form for pitch — the effect itself
    // didn't exist before — so we accept only the envelope-array shape.
    const envelope = parseEnvelopeOrSingle(params["envelope"], "pitch");
    if (!envelope) return null;
    return { kind: "pitch", params: { envelope } };
  }
  return null;
}

/** Validate PT transformer params. Falls back to standard defaults on any
 *  mismatch — keeps old v=3 payloads (no `pt` field) loadable. */
function parsePtParams(raw: unknown): PtTransformerParams {
  const fallback: PtTransformerParams = {
    monoMix: "average",
    targetNote: DEFAULT_TARGET_NOTE,
    resampleMode: DEFAULT_RESAMPLE_MODE,
    dither: false,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const x = raw as Record<string, unknown>;
  const mix = x["monoMix"];
  const monoMix: MonoMix =
    mix === "left" ? "left" : mix === "right" ? "right" : "average";
  const note = x["targetNote"];
  const targetNote =
    note === null
      ? null
      : typeof note === "number" && note >= 0 && note < 36
        ? Math.floor(note)
        : DEFAULT_TARGET_NOTE;
  const rs = x["resampleMode"];
  // Field added later — old payloads have nothing here, fall back to default.
  const resampleMode: ResampleMode = (
    RESAMPLE_MODES as readonly string[]
  ).includes(rs as string)
    ? (rs as ResampleMode)
    : DEFAULT_RESAMPLE_MODE;
  // Dither defaults to false for back-compat — old projects' int8 stays
  // bit-identical until the user explicitly turns it on.
  const dither = x["dither"] === true;
  // playingLengthTicks: optional, accept positive finite numbers; anything
  // else (missing, null, 0, NaN, negative) → null = disabled.
  const ticksRaw = x["playingLengthTicks"];
  const playingLengthTicks =
    typeof ticksRaw === "number" && Number.isFinite(ticksRaw) && ticksRaw > 0
      ? Math.floor(ticksRaw)
      : null;
  return { monoMix, targetNote, resampleMode, dither, playingLengthTicks };
}

/**
 * Validate a `chiptuneSources` map. Each entry must independently parse via
 * `chiptuneFromJson`; bad entries are silently dropped (better than failing
 * the whole load over a single corrupt slot). Slot indices are clamped to
 * [0, 30] — anything outside that range can't refer to a real PT sample slot.
 */
function parseChiptuneSources(raw: unknown): Record<number, ChiptuneParams> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<number, ChiptuneParams> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const slot = parseInt(k, 10);
    if (!Number.isFinite(slot) || slot < 0 || slot > 30) continue;
    const p = chiptuneFromJson(v);
    if (p) out[slot] = p;
  }
  return out;
}

/**
 * Validate a `patternNames` map. Indices must be in [0, 127] (M.K.'s
 * pattern-count cap) and values must be strings; bad entries are dropped
 * silently rather than failing the whole load. Trailing trims keep
 * empty-string entries from cluttering the map.
 */
function parsePatternNames(raw: unknown): Record<number, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const idx = parseInt(k, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx > 127) continue;
    if (typeof v !== "string") continue;
    const name = v.slice(0, 64);
    if (name.trim() === "") continue;
    out[idx] = name;
  }
  return out;
}

/**
 * Result of an autosave attempt:
 *   - "ok": the full session (including sampler source audio) was stored.
 *   - "degraded": the full payload didn't fit the storage quota, so the
 *     session was stored WITHOUT sampler source audio. The song bytes still
 *     carry every slot's rendered sample, so a reload restores the current
 *     song — but those slots come back without their workbench (source +
 *     effect chain).
 *   - "failed": nothing could be stored. Whatever an earlier successful
 *     save left under the key is still there, so a reload would roll back
 *     to it — the caller must tell the user.
 */
export type SaveOutcome = "ok" | "degraded" | "failed";

/**
 * Persist the inputs to localStorage and report how it went.
 *
 * Sampler sources are full-resolution WAVs and routinely exceed the
 * ~5 MB quota. A plain "swallow the error" policy left the PREVIOUS
 * session under the key, so a reload silently rolled the user back to
 * whatever state last fit. Instead we retry without the source audio,
 * which keeps the persisted song current, and surface the outcome.
 */
export function saveSession(state: SessionInputs): SaveOutcome {
  let json: string;
  try {
    json = JSON.stringify(buildPayload(state));
  } catch {
    return "failed";
  }
  try {
    localStorage.setItem(STORAGE_KEY, json);
    return "ok";
  } catch {
    // Quota exceeded, private browsing, etc. — fall through to the
    // reduced payload.
  }
  const hasSources =
    (!!state.samplerSources && Object.keys(state.samplerSources).length > 0) ||
    (!!state.xmSamplerSources &&
      Object.keys(state.xmSamplerSources).length > 0);
  if (!hasSources) return "failed";
  try {
    const lite = buildPayload({
      ...state,
      samplerSources: undefined,
      xmSamplerSources: undefined,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lite));
    return "degraded";
  } catch {
    return "failed";
  }
}

// ── Source store (IndexedDB) ──────────────────────────────────────────────
//
// With a source store, sampler audio is written there and the localStorage
// payload carries only ids. See state/sourceStore.ts for why.

/**
 * Store id of each `WavData` we have seen. Assigned on first save, and on
 * restore (so audio that came out of the store isn't written back under
 * a new id). Keyed by reference — a source's `WavData` is never mutated
 * in place, so a changed source is a new object and gets a new id.
 */
const sourceIds = new WeakMap<WavData, string>();

function newSourceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function sourceIdFor(wav: WavData): string {
  let id = sourceIds.get(wav);
  if (!id) {
    id = newSourceId();
    sourceIds.set(wav, id);
  }
  return id;
}

/**
 * Persist the session with sampler audio in `store`.
 *
 * Order matters: the audio is committed to the store BEFORE the
 * localStorage payload that references it is written, so a reload can
 * never find a reference without its audio. Afterwards, ids the new
 * payload doesn't reference are deleted — there is one autosave slot, so
 * anything else is garbage from replaced or removed sources.
 *
 * Rejects if the store fails (the caller falls back to `saveSession`).
 * Resolves "failed" if the audio is safe but the song payload itself
 * doesn't fit in localStorage.
 */
export async function saveSessionWithStore(
  state: SessionInputs,
  store: SourceStore,
): Promise<SaveOutcome> {
  const wavs: WavData[] = [
    ...Object.values(state.samplerSources ?? {}),
    ...Object.values(state.xmSamplerSources ?? {}),
  ].map((src) => src.wav);

  // Ask the store what it holds rather than remembering: another tab
  // sharing the autosave slot may have collected our audio.
  const present = new Set(await store.keys());
  const referenced = new Set<string>();
  for (const wav of wavs) {
    const id = sourceIdFor(wav);
    referenced.add(id);
    if (present.has(id)) continue;
    await store.put(id, writeWav(wav, { bitsPerSample: 16 }));
    present.add(id);
  }

  let json: string;
  try {
    json = JSON.stringify(buildPayload(state, sourceIdFor));
  } catch {
    return "failed";
  }
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    return "failed";
  }

  const garbage = [...present].filter((id) => !referenced.has(id));
  // Best-effort: a failed sweep only leaves unreferenced audio behind.
  await store.delete(garbage).catch(() => {});
  return "ok";
}

/**
 * Fetch the audio for sources a restored session referenced by id, and
 * return them in the same shape as inline sources. Entries whose audio
 * is missing or unreadable are dropped — the slot still plays from the
 * song bytes, it just comes back without its workbench.
 */
export async function resolvePendingSources(
  pending: readonly PendingSource[],
  store: SourceStore,
): Promise<{
  samplerSources: Record<number, SamplerSourceInputs>;
  xmSamplerSources: Record<string, XmSamplerSourceInputs>;
}> {
  const samplerSources: Record<number, SamplerSourceInputs> = {};
  const xmSamplerSources: Record<string, XmSamplerSourceInputs> = {};
  // Several slots can share one source (duplicated samples): fetch and
  // decode each id once so they keep sharing a single `WavData`.
  const decoded = new Map<string, WavData | null>();
  for (const p of pending) {
    let wav = decoded.get(p.ref);
    if (wav === undefined) {
      wav = null;
      try {
        const bytes = await store.get(p.ref);
        if (bytes) {
          wav = readWav(bytes);
          sourceIds.set(wav, p.ref);
        }
      } catch {
        wav = null;
      }
      decoded.set(p.ref, wav);
    }
    if (!wav) continue;
    const chain = fixupSentinelFrames(p.chain, wav, p.sourceName);
    if (p.kind === "pt") {
      samplerSources[p.slot] = {
        sourceName: p.sourceName,
        wav,
        chain,
        pt: p.pt,
      };
    } else {
      xmSamplerSources[p.key] = {
        sourceName: p.sourceName,
        wav,
        chain,
        xm: p.xm,
      };
    }
  }
  return { samplerSources, xmSamplerSources };
}

/**
 * Autosave entry point: use the source store when there is one, and fall
 * back to the inline `saveSession` when there isn't or it fails.
 */
export async function saveSessionAuto(
  state: SessionInputs,
): Promise<SaveOutcome> {
  const store = getSourceStore();
  if (!store) return saveSession(state);
  try {
    return await saveSessionWithStore(state, store);
  } catch {
    // IndexedDB is unusable (private window, blocked, quota). Stop using
    // it for this session so every later save doesn't pay for a failure.
    setSourceStore(null);
    return saveSession(state);
  }
}

let saveRunning = false;
let saveQueued: SessionInputs | null = null;

/**
 * Run autosaves one at a time. A store-backed save is asynchronous, and
 * two overlapping ones could interleave their "write audio, write
 * payload, sweep garbage" steps — the earlier sweep deleting audio the
 * later payload references. While one is in flight only the most recent
 * request is kept; older ones are superseded.
 *
 * A save (or its `onOutcome`) that throws must not strand the queued
 * request: left behind, it would be written AFTER the next, newer call's
 * state and roll the stored session back. So the queue is always drained
 * — the queued request is newer than the one that threw — and the first
 * error is rethrown once it is empty.
 */
export async function queueSessionSave(
  state: SessionInputs,
  onOutcome: (outcome: SaveOutcome) => void,
): Promise<void> {
  if (saveRunning) {
    saveQueued = state;
    return;
  }
  saveRunning = true;
  let failed = false;
  let firstError: unknown;
  let next: SessionInputs | null = state;
  while (next) {
    try {
      onOutcome(await saveSessionAuto(next));
    } catch (err) {
      if (!failed) {
        failed = true;
        firstError = err;
      }
    }
    next = saveQueued;
    saveQueued = null;
  }
  saveRunning = false;
  if (failed) throw firstError;
}

/** Restore a previously saved session, or null if none / corrupt. */
export function loadSession(): LoadedSession | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return payloadToSession(parsed);
}

/** Drop the persisted session. */
export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── .retro project file format ────────────────────────────────────────────
//
// Same on-disk shape as the localStorage payload — UTF-8 JSON with the song
// bytes embedded as base64. The two transports (localStorage / file) share
// the validator and the build helper so a saved `.retro` can be dropped
// straight into the autosave slot and vice versa.

/** Encode a session as the bytes of a `.retro` project file. */
export function projectToBytes(state: SessionInputs): Uint8Array {
  const json = JSON.stringify(buildPayload(state));
  return new TextEncoder().encode(json);
}

/** Decode `.retro` bytes to a LoadedSession; null on any parse failure. */
export function projectFromBytes(bytes: Uint8Array): LoadedSession | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return payloadToSession(parsed);
}

/**
 * Pick a download filename for a `.retro` project. Same heuristic as
 * `deriveExportFilename` (loaded name → song title → "untitled"), but
 * strips the `.mod` / `.xm` / `.retro` extension on the way in so a user
 * doesn't end up with `Demo.mod.retro` or `Demo.xm.retro`.
 */
export function deriveProjectFilename(
  loadedName: string | null,
  songTitle: string,
): string {
  const base = loadedName
    ? loadedName.replace(/\.(mod|xm|retro)$/i, "")
    : songTitle.trim();
  const sanitised = base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_");
  const trimmed = sanitised.slice(0, 64);
  return `${trimmed || "untitled"}.retro`;
}

// ── Validation helpers ────────────────────────────────────────────────────

function isPersistedShape(v: unknown): v is PersistedShape {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  // Accept v=1 (oldest, no source maps), v=2 (chiptuneSources added),
  // v=3 (samplerSources added), v=4 (patternNames added), and v=5
  // (per-channel mute/solo added). Per-slot maps are validated
  // entry-by-entry in their parse helpers so a single corrupt slot
  // doesn't fail the whole load.
  return (
    (x["v"] === 1 ||
      x["v"] === 2 ||
      x["v"] === 3 ||
      x["v"] === 4 ||
      x["v"] === 5 ||
      x["v"] === 6 ||
      x["v"] === 7 ||
      x["v"] === 8 ||
      x["v"] === 9) &&
    typeof x["songBase64"] === "string" &&
    (x["filename"] === null || typeof x["filename"] === "string") &&
    (x["infoText"] === undefined || typeof x["infoText"] === "string") &&
    (x["view"] === "pattern" ||
      x["view"] === "sample" ||
      x["view"] === "info" ||
      x["view"] === "settings") &&
    typeof x["cursor"] === "object" &&
    x["cursor"] !== null &&
    typeof x["currentSample"] === "number" &&
    typeof x["currentOctave"] === "number" &&
    typeof x["editStep"] === "number"
  );
}

/** Clamp a persisted cursor to the FORMAT's limits. The loader then
 *  clamps against the actual song (`reconcileUiToSong`). PT's fixed
 *  64 × 4 grid used to be applied to FT2 too, snapping the cursor back
 *  on any pattern longer than 64 rows or wider than 4 channels. */
function sanitiseCursor(c: Cursor, format: "PT2" | "FT2"): Cursor {
  const field: Field = (FIELDS as readonly string[]).includes(c.field)
    ? c.field
    : "note";
  const ft2 = format === "FT2";
  return {
    order: clamp(c.order, 0, (ft2 ? XM_MAX_ORDERS : MAX_ORDERS) - 1, 0),
    row: clamp(c.row, 0, (ft2 ? XM_MAX_PATTERN_ROWS : ROWS_PER_PATTERN) - 1, 0),
    channel: clamp(c.channel, 0, (ft2 ? XM_MAX_CHANNELS : CHANNELS) - 1, 0),
    field,
  };
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}
