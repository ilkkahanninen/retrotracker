import { parseModule } from '../core/mod/parser';
import { writeModule } from '../core/mod/writer';
import type { Song } from '../core/mod/types';
import { FIELDS, type Cursor, type Field } from './cursor';
import type { View } from './view';
import type { ChiptuneParams } from '../core/audio/chiptune';
import { chiptuneFromJson } from '../core/audio/chiptune';
import type { WavData } from '../core/audio/wav';
import { readWav, writeWav } from '../core/audio/wav';
import type {
  EffectNode,
  MonoMix,
  PtTransformerParams,
} from '../core/audio/sampleWorkbench';
import { DEFAULT_TARGET_NOTE } from '../core/audio/sampleWorkbench';

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
 *     can blow the localStorage quota; saveSession swallows that silently
 *     and the user falls back to explicit Save.
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

const STORAGE_KEY = 'retrotracker:session:v1';

type SchemaVersion = 1 | 2 | 3 | 4;

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
   * inventing a parallel JSON shape.
   */
  wavBase64: string;
  /** Effect chain in original order. Optional for back-compat. */
  chain?: EffectNode[];
  /** PT transformer params (mono mix + target note). Optional for back-compat. */
  pt?: PtTransformerParams;
}

interface PersistedShape {
  v: SchemaVersion;
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

export interface SessionInputs {
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
}

/** A session that has been read back: same shape as SessionInputs, but
 *  `infoText` is always materialised (never undefined) so the App can
 *  `setInfoText` without a fallback at every call site. */
export type LoadedSession = Omit<
  SessionInputs,
  'infoText' | 'chiptuneSources' | 'samplerSources' | 'patternNames'
> & {
  infoText: string;
  /** Always materialised on load — empty record when none persisted. */
  chiptuneSources: Record<number, ChiptuneParams>;
  /** Always materialised on load — empty record when none persisted. */
  samplerSources: Record<number, SamplerSourceInputs>;
  /** Always materialised on load — empty record when none persisted. */
  patternNames: Record<number, string>;
};

function bytesToBase64(bytes: Uint8Array): string {
  // The CharCode-loop / btoa pair is the smallest reliable Uint8Array→base64
  // path in browsers without TextDecoder hijinks. We chunk to avoid the
  // String.fromCharCode argument-list cap (~64KB on V8). A typical .mod
  // sits under that anyway, but big sample data can push past.
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
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
 * Cached base64 encoding of the most recently encoded Song. The autosave
 * effect fires on every cursor move / view toggle / current-sample change,
 * but the song itself rarely changes between those firings. Re-running
 * writeModule + base64 on a 16-pattern song with samples is ~10–50 ms of
 * synchronous work; reusing the cached string when `state.song === lastSong`
 * keeps a Cmd+S / autosave roundtrip in the sub-millisecond range.
 *
 * We compare by reference because every commit produces a new Song —
 * `commitEdit` builds the new song immutably, so reference equality is a
 * sound proxy for "song unchanged". A direct `setSong` from outside the
 * commit path would invalidate the cache the moment it's called.
 */
let lastSong: Song | null = null;
let lastBase64: string | null = null;

function encodeSongCached(song: Song): string {
  if (lastSong === song && lastBase64 !== null) return lastBase64;
  const b64 = bytesToBase64(writeModule(song));
  lastSong = song;
  lastBase64 = b64;
  return b64;
}

/** Build the on-the-wire payload — song goes through writeModule + base64
 *  so we re-use the lossless M.K. binary instead of inventing a JSON shape
 *  for the sample data.  Throws if `writeModule` rejects the song. */
function buildPayload(state: SessionInputs): PersistedShape {
  const hasChiptune    = !!state.chiptuneSources && Object.keys(state.chiptuneSources).length > 0;
  const hasSampler     = !!state.samplerSources  && Object.keys(state.samplerSources).length > 0;
  const hasPatternNames = !!state.patternNames   && Object.keys(state.patternNames).length > 0;
  // Lowest version that fits the data — keeps a chiptune/sampler/names-free
  // session bit-identical to the original v=1 format and lets older builds
  // keep loading anything they can still understand.
  const v: SchemaVersion = hasPatternNames ? 4 : hasSampler ? 3 : hasChiptune ? 2 : 1;
  return {
    v,
    songBase64: encodeSongCached(state.song),
    filename: state.filename,
    infoText: state.infoText ?? '',
    view: state.view,
    cursor: state.cursor,
    currentSample: state.currentSample,
    currentOctave: state.currentOctave,
    editStep: state.editStep,
    ...(hasChiptune     ? { chiptuneSources: state.chiptuneSources } : {}),
    ...(hasSampler      ? { samplerSources:  encodeSamplerSources(state.samplerSources!) } : {}),
    ...(hasPatternNames ? { patternNames:    state.patternNames } : {}),
  };
}

/** Encode each sampler source's WavData as 16-bit PCM bytes → base64,
 *  alongside the chain + PT params. Slot keys are preserved verbatim
 *  (numeric strings) so the JSON map parses back symmetrically. */
function encodeSamplerSources(
  src: Record<number, SamplerSourceInputs>,
): Record<number, PersistedSamplerSource> {
  const out: Record<number, PersistedSamplerSource> = {};
  for (const [k, v] of Object.entries(src)) {
    out[Number(k)] = {
      sourceName: v.sourceName,
      wavBase64: bytesToBase64(writeWav(v.wav, { bitsPerSample: 16 })),
      ...(v.chain.length > 0 ? { chain: v.chain } : {}),
      pt: v.pt,
    };
  }
  return out;
}

/** Decode a (presumed) PersistedShape back to a LoadedSession. Returns
 *  null on any shape / parse failure. Shared by localStorage and the
 *  `.retro` file-import path so they validate identically. */
function payloadToSession(parsed: unknown): LoadedSession | null {
  if (!isPersistedShape(parsed)) return null;
  let song: Song;
  try {
    const bytes = base64ToBytes(parsed.songBase64);
    song = parseModule(bytes.buffer);
  } catch {
    return null;
  }
  return {
    song,
    filename: parsed.filename ?? null,
    infoText: typeof parsed.infoText === 'string' ? parsed.infoText : '',
    view:
      parsed.view === 'sample' ? 'sample'
      : parsed.view === 'info' ? 'info'
      : 'pattern',
    cursor: sanitiseCursor(parsed.cursor),
    currentSample: clamp(parsed.currentSample, 1, 31, 1),
    currentOctave: clamp(parsed.currentOctave, 1, 3, 2),
    editStep: clamp(parsed.editStep, 0, 16, 1),
    chiptuneSources: parseChiptuneSources(parsed.chiptuneSources),
    samplerSources: parseSamplerSources(parsed.samplerSources),
    patternNames: parsePatternNames(parsed.patternNames),
  };
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
function parseSamplerSources(raw: unknown): Record<number, SamplerSourceInputs> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<number, SamplerSourceInputs> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const slot = parseInt(k, 10);
    if (!Number.isFinite(slot) || slot < 0 || slot > 30) continue;
    if (!v || typeof v !== 'object') continue;
    const entry = v as Record<string, unknown>;
    const sourceName = typeof entry['sourceName'] === 'string' ? entry['sourceName'] : '';
    const wavBase64  = typeof entry['wavBase64']  === 'string' ? entry['wavBase64']  : null;
    if (!wavBase64) continue;
    try {
      const wav = readWav(base64ToBytes(wavBase64));
      out[slot] = {
        sourceName,
        wav,
        chain: parseEffectChain(entry['chain']),
        pt: parsePtParams(entry['pt']),
      };
    } catch {
      // Corrupt WAV bytes — drop this slot and continue.
    }
  }
  return out;
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

/** Validate one EffectNode. Returns null on any structural mismatch. */
function parseEffectNode(v: unknown): EffectNode | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const kind = x['kind'];
  if (kind === 'normalize') return { kind: 'normalize' };
  const p = x['params'];
  if (!p || typeof p !== 'object') return null;
  const params = p as Record<string, unknown>;
  if (kind === 'gain') {
    if (typeof params['gain'] !== 'number') return null;
    return { kind: 'gain', params: { gain: params['gain'] } };
  }
  if (kind === 'reverse' || kind === 'crop' || kind === 'cut'
      || kind === 'fadeIn' || kind === 'fadeOut') {
    if (typeof params['startFrame'] !== 'number') return null;
    if (typeof params['endFrame']   !== 'number') return null;
    return {
      kind,
      params: {
        startFrame: Math.max(0, Math.floor(params['startFrame'])),
        endFrame:   Math.max(0, Math.floor(params['endFrame'])),
      },
    };
  }
  if (kind === 'filter') {
    const type = params['type'];
    if (type !== 'lowpass' && type !== 'highpass') return null;
    if (typeof params['cutoff'] !== 'number') return null;
    if (typeof params['q']      !== 'number') return null;
    return {
      kind: 'filter',
      params: {
        type,
        // Soft-clamp here mirrors the runtime guards in `applyFilter`; an
        // out-of-range payload still loads, just snapped to a sane edge.
        cutoff: Math.max(10, params['cutoff']),
        q:      Math.max(0.05, Math.min(30, params['q'])),
      },
    };
  }
  if (kind === 'crossfade') {
    if (typeof params['length'] !== 'number') return null;
    return {
      kind: 'crossfade',
      params: { length: Math.max(1, Math.floor(params['length'])) },
    };
  }
  return null;
}

/** Validate PT transformer params. Falls back to standard defaults on any
 *  mismatch — keeps old v=3 payloads (no `pt` field) loadable. */
function parsePtParams(raw: unknown): PtTransformerParams {
  const fallback: PtTransformerParams = {
    monoMix: 'average',
    targetNote: DEFAULT_TARGET_NOTE,
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const x = raw as Record<string, unknown>;
  const mix = x['monoMix'];
  const monoMix: MonoMix =
    mix === 'left' ? 'left' : mix === 'right' ? 'right' : 'average';
  const note = x['targetNote'];
  const targetNote =
    note === null ? null
    : typeof note === 'number' && note >= 0 && note < 36 ? Math.floor(note)
    : DEFAULT_TARGET_NOTE;
  return { monoMix, targetNote };
}

/**
 * Validate a `chiptuneSources` map. Each entry must independently parse via
 * `chiptuneFromJson`; bad entries are silently dropped (better than failing
 * the whole load over a single corrupt slot). Slot indices are clamped to
 * [0, 30] — anything outside that range can't refer to a real PT sample slot.
 */
function parseChiptuneSources(raw: unknown): Record<number, ChiptuneParams> {
  if (!raw || typeof raw !== 'object') return {};
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
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const idx = parseInt(k, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx > 127) continue;
    if (typeof v !== 'string') continue;
    const name = v.slice(0, 64);
    if (name.trim() === '') continue;
    out[idx] = name;
  }
  return out;
}

/** Persist the inputs to localStorage. Silent on quota / SecurityErrors. */
export function saveSession(state: SessionInputs): void {
  let payload: PersistedShape;
  try {
    payload = buildPayload(state);
  } catch {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded, private browsing, etc. — silent. Persistence is a
    // best-effort convenience; the user explicitly Save-As'es to keep work.
  }
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
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
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
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
 * strips both `.mod` and `.retro` extensions on the way in so a user
 * doesn't end up with `Demo.mod.retro`.
 */
export function deriveProjectFilename(
  loadedName: string | null,
  songTitle: string,
): string {
  const base = loadedName
    ? loadedName.replace(/\.(mod|retro)$/i, '')
    : songTitle.trim();
  const sanitised = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  const trimmed = sanitised.slice(0, 64);
  return `${trimmed || 'untitled'}.retro`;
}

// ── Validation helpers ────────────────────────────────────────────────────

function isPersistedShape(v: unknown): v is PersistedShape {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  // Accept v=1 (oldest, no source maps), v=2 (chiptuneSources added),
  // v=3 (samplerSources added) and v=4 (patternNames added). Per-slot
  // maps are validated entry-by-entry in their parse helpers so a single
  // corrupt slot doesn't fail the whole load.
  return (x['v'] === 1 || x['v'] === 2 || x['v'] === 3 || x['v'] === 4)
    && typeof x['songBase64'] === 'string'
    && (x['filename'] === null || typeof x['filename'] === 'string')
    && (x['infoText'] === undefined || typeof x['infoText'] === 'string')
    && (x['view'] === 'pattern' || x['view'] === 'sample' || x['view'] === 'info')
    && typeof x['cursor'] === 'object' && x['cursor'] !== null
    && typeof x['currentSample'] === 'number'
    && typeof x['currentOctave'] === 'number'
    && typeof x['editStep'] === 'number';
}

function sanitiseCursor(c: Cursor): Cursor {
  const field: Field = (FIELDS as readonly string[]).includes(c.field) ? c.field : 'note';
  return {
    order: clamp(c.order, 0, 127, 0),
    row: clamp(c.row, 0, 63, 0),
    channel: clamp(c.channel, 0, 3, 0),
    field,
  };
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}
