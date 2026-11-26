import { createSignal } from "solid-js";

/**
 * Blob store for sampler source audio.
 *
 * The autosaved session used to carry every sampler source inline as
 * base64 inside one localStorage string. Source audio is by far the
 * largest part of a project — 30 seconds of stereo is ~7 MB encoded —
 * and localStorage holds about 5 MB, so a project with a few long samples
 * could not be autosaved with its sources at all.
 *
 * Sources now live here, in IndexedDB (quota is a share of free disk,
 * not a fixed few MB), keyed by an opaque id. The localStorage session
 * keeps only the ids. `.retro` project files are unaffected — they still
 * embed the audio so a file stays self-contained.
 *
 * The interface is deliberately tiny so the session code can be tested
 * against an in-memory implementation; the IndexedDB one is exercised in
 * a real browser.
 */
export interface SourceStore {
  /** Every id currently stored. */
  keys(): Promise<string[]>;
  /** The bytes stored under `id`, or undefined when there are none. */
  get(id: string): Promise<Uint8Array | undefined>;
  /** Store `bytes` under `id`, replacing any previous value. */
  put(id: string, bytes: Uint8Array): Promise<void>;
  /** Remove the given ids. Missing ids are ignored. */
  delete(ids: readonly string[]): Promise<void>;
}

const DB_NAME = "retrotracker";
const DB_VERSION = 1;
const STORE_NAME = "sources";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB error"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB error"));
  });
}

/** IndexedDB-backed store. The database is opened lazily, once. */
export function createIdbSourceStore(factory: IDBFactory): SourceStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open"));
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return opening;
  };
  return {
    async keys() {
      const tx = (await db()).transaction(STORE_NAME, "readonly");
      const keys = await request(tx.objectStore(STORE_NAME).getAllKeys());
      return keys.map(String);
    },
    async get(id) {
      const tx = (await db()).transaction(STORE_NAME, "readonly");
      const v: unknown = await request(tx.objectStore(STORE_NAME).get(id));
      return v instanceof Uint8Array ? v : undefined;
    },
    async put(id, bytes) {
      const tx = (await db()).transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(bytes, id);
      await done(tx);
    },
    async delete(ids) {
      if (ids.length === 0) return;
      const tx = (await db()).transaction(STORE_NAME, "readwrite");
      const os = tx.objectStore(STORE_NAME);
      for (const id of ids) os.delete(id);
      await done(tx);
    },
  };
}

/** Plain in-memory store — used by tests, and handy as a reference for
 *  what the session code expects of a store. */
export function createMemorySourceStore(): SourceStore & {
  readonly map: Map<string, Uint8Array>;
} {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async keys() {
      return [...map.keys()];
    },
    async get(id) {
      return map.get(id);
    },
    async put(id, bytes) {
      map.set(id, bytes);
    },
    async delete(ids) {
      for (const id of ids) map.delete(id);
    },
  };
}

// ── The app's store ───────────────────────────────────────────────────────

let active: SourceStore | null | undefined;

const [available, setAvailable] = createSignal(
  typeof indexedDB !== "undefined",
);

/**
 * True while source audio is being kept in the blob store. False when
 * IndexedDB doesn't exist (tests, some embedded browsers) or has failed
 * (Firefox private windows reject every open) — the session then falls
 * back to carrying sources inline in localStorage, with its size limit.
 * Reactive, so the UI can describe the storage budget correctly.
 */
export const sourceStoreAvailable = available;

/** The store the session should use, or null to keep sources inline. */
export function getSourceStore(): SourceStore | null {
  if (active === undefined) {
    active =
      typeof indexedDB !== "undefined" ? createIdbSourceStore(indexedDB) : null;
    setAvailable(active !== null);
  }
  return active;
}

/**
 * Replace the store (tests), or pass null to disable it. Also the
 * failure path: when a store operation rejects, the session calls
 * `setSourceStore(null)` and carries on inline.
 */
export function setSourceStore(store: SourceStore | null): void {
  active = store;
  setAvailable(store !== null);
}

/** Forget any override and go back to auto-detection (tests). */
export function resetSourceStore(): void {
  active = undefined;
  setAvailable(typeof indexedDB !== "undefined");
}
