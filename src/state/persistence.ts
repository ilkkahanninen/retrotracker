import { parseModule } from '../core/mod/parser';
import { writeModule } from '../core/mod/writer';
import type { Song } from '../core/mod/types';
import { FIELDS, type Cursor, type Field } from './cursor';
import type { View } from './view';

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
 * step, filename) are bundled around the song bytes as plain JSON. We don't
 * persist:
 *   - Workbenches (WAV source + effect chain) — these can be MB-sized and
 *     localStorage isn't the right home; they go away on reload.
 *   - History stacks — a fresh session starts with no undo, matching the
 *     "Open .mod" path which also calls clearHistory.
 *   - Selection / clipboard — ephemeral.
 *   - Transport / playPos — playback never resumes mid-stream.
 *
 * The key includes a `:v1` suffix so a future schema change can bump the
 * version and reject the old payload cleanly (read-side returns null on a
 * shape mismatch).
 */

const STORAGE_KEY = 'retrotracker:session:v1';

interface PersistedShape {
  v: 1;
  songBase64: string;
  filename: string | null;
  /** Optional in v=1: older snapshots predate the Info view and load with ''. */
  infoText?: string;
  view: View;
  cursor: Cursor;
  currentSample: number;
  currentOctave: number;
  editStep: number;
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
}

/** A session that has been read back: same shape as SessionInputs, but
 *  `infoText` is always materialised (never undefined) so the App can
 *  `setInfoText` without a fallback at every call site. */
export type LoadedSession = Omit<SessionInputs, 'infoText'> & { infoText: string };

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

/** Encode the song to base64, returning the cached value when possible.
 *  Exposed for tests via `__resetEncodeCacheForTests`. */
function encodeSongCached(song: Song): string {
  if (lastSong === song && lastBase64 !== null) return lastBase64;
  const b64 = bytesToBase64(writeModule(song));
  lastSong = song;
  lastBase64 = b64;
  return b64;
}

/** Test hook — reset the encode cache between tests so a song that
 *  happens to hold the same JS reference across `setSong(null)` boundaries
 *  doesn't return the previous encoding by mistake. */
export function __resetEncodeCacheForTests(): void {
  lastSong = null;
  lastBase64 = null;
}

/** Build the on-the-wire payload — song goes through writeModule + base64
 *  so we re-use the lossless M.K. binary instead of inventing a JSON shape
 *  for the sample data.  Throws if `writeModule` rejects the song. */
function buildPayload(state: SessionInputs): PersistedShape {
  return {
    v: 1,
    songBase64: encodeSongCached(state.song),
    filename: state.filename,
    infoText: state.infoText ?? '',
    view: state.view,
    cursor: state.cursor,
    currentSample: state.currentSample,
    currentOctave: state.currentOctave,
    editStep: state.editStep,
  };
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
  };
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
  return x['v'] === 1
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
