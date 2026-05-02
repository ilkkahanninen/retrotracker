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
  view: View;
  cursor: Cursor;
  currentSample: number;
  currentOctave: number;
  editStep: number;
}

export interface SessionInputs {
  song: Song;
  filename: string | null;
  view: View;
  cursor: Cursor;
  currentSample: number;
  currentOctave: number;
  editStep: number;
}

export interface LoadedSession extends SessionInputs {}

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

/** Persist the inputs to localStorage. Silent on quota / SecurityErrors. */
export function saveSession(state: SessionInputs): void {
  let bytes: Uint8Array;
  try {
    bytes = writeModule(state.song);
  } catch {
    // Song shape unwritable (shouldn't happen with anything we built) — bail.
    return;
  }
  const payload: PersistedShape = {
    v: 1,
    songBase64: bytesToBase64(bytes),
    filename: state.filename,
    view: state.view,
    cursor: state.cursor,
    currentSample: state.currentSample,
    currentOctave: state.currentOctave,
    editStep: state.editStep,
  };
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
  if (!isPersistedShape(parsed)) return null;

  let song: Song;
  try {
    const bytes = base64ToBytes(parsed.songBase64);
    // parseModule wants ArrayBuffer; the Uint8Array's underlying buffer is
    // sufficient because we built it from a fresh allocation.
    song = parseModule(bytes.buffer);
  } catch {
    return null;
  }

  return {
    song,
    filename: parsed.filename ?? null,
    view: parsed.view === 'sample' ? 'sample' : 'pattern',
    cursor: sanitiseCursor(parsed.cursor),
    currentSample: clamp(parsed.currentSample, 1, 31, 1),
    currentOctave: clamp(parsed.currentOctave, 1, 3, 2),
    editStep: clamp(parsed.editStep, 0, 16, 1),
  };
}

/** Drop the persisted session. */
export function clearSession(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ── Validation helpers ────────────────────────────────────────────────────

function isPersistedShape(v: unknown): v is PersistedShape {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  return x['v'] === 1
    && typeof x['songBase64'] === 'string'
    && (x['filename'] === null || typeof x['filename'] === 'string')
    && (x['view'] === 'pattern' || x['view'] === 'sample')
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
