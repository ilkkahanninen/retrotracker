/**
 * Autosave with sampler sources in the source store (IndexedDB in the
 * app; an in-memory store here). The session payload in localStorage
 * carries ids, the store carries the audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WavData } from "../src/core/audio/wav";
import { emptySong } from "../src/core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import {
  loadSession,
  projectFromBytes,
  projectToBytes,
  queueSessionSave,
  resolvePendingSources,
  saveSession,
  saveSessionAuto,
  saveSessionWithStore,
  type SaveOutcome,
  type SessionInputs,
} from "../src/state/persistence";
import {
  createMemorySourceStore,
  resetSourceStore,
  setSourceStore,
  sourceStoreAvailable,
  type SourceStore,
} from "../src/state/sourceStore";

const STORAGE_KEY = "retrotracker:session:v1";
/** Small enough that one inline source overflows it; the song fits. */
const QUOTA = 64 * 1024;
const BIG_FRAMES = 80_000;

function installStorage(quotaChars: number): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (k.length + v.length > quotaChars) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

function wav(frames: number, seed = 1): WavData {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i * seed) / 20) * 0.5;
  return { sampleRate: 44100, channels: [ch] };
}

const PT = {
  monoMix: "average" as const,
  targetNote: 12,
  resampleMode: "linear" as never,
  dither: false,
};

function inputs(over: Partial<SessionInputs> = {}): SessionInputs {
  return {
    song: emptySong(),
    filename: "a.mod",
    infoText: "",
    view: "pattern",
    cursor: { order: 0, row: 0, channel: 0, field: "note" },
    currentSample: 1,
    currentOctave: 2,
    editStep: 1,
    ...over,
  };
}
const ptSource = (w: WavData, name = "big.wav") => ({
  sourceName: name,
  wav: w,
  chain: [],
  pt: PT,
});

let saved: unknown;
let storage: Map<string, string>;
beforeEach(() => {
  saved = (globalThis as { localStorage?: unknown }).localStorage;
  storage = installStorage(QUOTA);
});
afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = saved;
  resetSourceStore();
  vi.restoreAllMocks();
});

describe("saveSessionWithStore", () => {
  it("keeps a source that would not fit inline", async () => {
    const store = createMemorySourceStore();
    const w = wav(BIG_FRAMES);
    // Baseline: inline, this degrades.
    expect(saveSession(inputs({ samplerSources: { 0: ptSource(w) } }))).toBe(
      "degraded",
    );

    const outcome = await saveSessionWithStore(
      inputs({
        song: { ...emptySong(), title: "current" },
        samplerSources: { 0: ptSource(w) },
      }),
      store,
    );
    expect(outcome).toBe("ok");
    expect(store.map.size).toBe(1);

    // The payload references the audio instead of embedding it.
    const payload = storage.get(STORAGE_KEY)!;
    expect(payload.length).toBeLessThan(10_000);
    expect(payload).not.toContain("wavBase64");
    expect(payload).toContain("wavRef");

    const back = loadSession()!;
    expect(back.song.title).toBe("current");
    expect(back.samplerSources).toEqual({});
    expect(back.pendingSources).toHaveLength(1);

    const resolved = await resolvePendingSources(back.pendingSources, store);
    const src = resolved.samplerSources[0]!;
    expect(src.sourceName).toBe("big.wav");
    expect(src.pt).toEqual({ ...PT, playingLengthTicks: null });
    expect(src.wav.sampleRate).toBe(44100);
    expect(src.wav.channels[0]!.length).toBe(BIG_FRAMES);
  });

  it("round-trips the effect chain alongside the reference", async () => {
    const store = createMemorySourceStore();
    await saveSessionWithStore(
      inputs({
        samplerSources: {
          0: {
            ...ptSource(wav(2000)),
            chain: [
              { kind: "normalize" },
              { kind: "crop", params: { startFrame: 10, endFrame: 900 } },
            ],
          },
        },
      }),
      store,
    );
    const resolved = await resolvePendingSources(
      loadSession()!.pendingSources,
      store,
    );
    expect(resolved.samplerSources[0]!.chain).toEqual([
      { kind: "normalize" },
      { kind: "crop", params: { startFrame: 10, endFrame: 900 } },
    ]);
  });

  it("does not rewrite audio that is already stored", async () => {
    const store = createMemorySourceStore();
    const put = vi.spyOn(store, "put");
    const w = wav(2000);
    const state = (title: string) =>
      inputs({
        song: { ...emptySong(), title },
        samplerSources: { 0: ptSource(w) },
      });
    await saveSessionWithStore(state("one"), store);
    await saveSessionWithStore(state("two"), store); // e.g. a note was typed
    await saveSessionWithStore(state("three"), store);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("sweeps audio the session no longer references", async () => {
    const store = createMemorySourceStore();
    const a = wav(2000, 1);
    const b = wav(2000, 2);
    await saveSessionWithStore(
      inputs({ samplerSources: { 0: ptSource(a), 1: ptSource(b) } }),
      store,
    );
    expect(store.map.size).toBe(2);

    // Slot 1 cleared, slot 0's source replaced.
    const c = wav(3000, 3);
    await saveSessionWithStore(
      inputs({ samplerSources: { 0: ptSource(c) } }),
      store,
    );
    expect(store.map.size).toBe(1);
    const back = loadSession()!;
    const resolved = await resolvePendingSources(back.pendingSources, store);
    expect(resolved.samplerSources[0]!.wav.channels[0]!.length).toBe(3000);

    await saveSessionWithStore(inputs(), store);
    expect(store.map.size).toBe(0);
  });

  it("writes the audio before the payload that references it", async () => {
    const store = createMemorySourceStore();
    const order: string[] = [];
    const put = store.put.bind(store);
    store.put = async (id, bytes) => {
      order.push("put");
      await put(id, bytes);
    };
    const ls = (globalThis as { localStorage: Storage }).localStorage;
    const setItem = ls.setItem.bind(ls);
    ls.setItem = (k: string, v: string) => {
      order.push("setItem");
      setItem(k, v);
    };
    await saveSessionWithStore(
      inputs({ samplerSources: { 0: ptSource(wav(2000)) } }),
      store,
    );
    expect(order).toEqual(["put", "setItem"]);
  });

  it("slots sharing one source store it once and get it back shared", async () => {
    const store = createMemorySourceStore();
    const w = wav(2000);
    await saveSessionWithStore(
      inputs({ samplerSources: { 0: ptSource(w), 3: ptSource(w, "copy") } }),
      store,
    );
    expect(store.map.size).toBe(1);
    const resolved = await resolvePendingSources(
      loadSession()!.pendingSources,
      store,
    );
    expect(resolved.samplerSources[0]!.wav).toBe(
      resolved.samplerSources[3]!.wav,
    );
  });

  it("restored audio keeps its id — the next save writes nothing new", async () => {
    const store = createMemorySourceStore();
    await saveSessionWithStore(
      inputs({ samplerSources: { 0: ptSource(wav(2000)) } }),
      store,
    );
    const [id] = [...store.map.keys()];
    const resolved = await resolvePendingSources(
      loadSession()!.pendingSources,
      store,
    );
    const put = vi.spyOn(store, "put");
    await saveSessionWithStore(
      inputs({ samplerSources: resolved.samplerSources }),
      store,
    );
    expect(put).not.toHaveBeenCalled();
    expect([...store.map.keys()]).toEqual([id]);
  });

  it("handles XM sampler sources the same way", async () => {
    const store = createMemorySourceStore();
    const song = { ...emptyXmSong(), title: "xm" };
    song.instruments = [emptyXmInstrument()];
    const outcome = await saveSessionWithStore(
      inputs({
        song,
        xmSamplerSources: {
          "1:0": {
            sourceName: "big.wav",
            wav: wav(BIG_FRAMES),
            chain: [],
            xm: { monoMix: "average", bitDepth: 16 },
          },
        },
      }),
      store,
    );
    expect(outcome).toBe("ok");
    const back = loadSession()!;
    expect(back.pendingSources[0]).toMatchObject({ kind: "xm", key: "1:0" });
    const resolved = await resolvePendingSources(back.pendingSources, store);
    expect(resolved.xmSamplerSources["1:0"]!.xm).toEqual({
      monoMix: "average",
      bitDepth: 16,
    });
    expect(resolved.xmSamplerSources["1:0"]!.wav.channels[0]!.length).toBe(
      BIG_FRAMES,
    );
  });

  it("reports failed when the song payload itself does not fit", async () => {
    installStorage(16);
    const store = createMemorySourceStore();
    expect(await saveSessionWithStore(inputs(), store)).toBe("failed");
  });
});

describe("resolvePendingSources", () => {
  it("drops entries whose audio is missing or unreadable", async () => {
    const store = createMemorySourceStore();
    await saveSessionWithStore(
      inputs({
        samplerSources: {
          0: ptSource(wav(2000, 1)),
          1: ptSource(wav(2000, 2)),
          2: ptSource(wav(2000, 3)),
        },
      }),
      store,
    );
    const pending = loadSession()!.pendingSources;
    const refOf = (slot: number) =>
      pending.find((p) => p.kind === "pt" && p.slot === slot)!.ref;
    store.map.delete(refOf(1));
    store.map.set(refOf(2), new Uint8Array([1, 2, 3]));
    const resolved = await resolvePendingSources(pending, store);
    expect(Object.keys(resolved.samplerSources)).toEqual(["0"]);
  });

  it("ignores malformed references in a payload", () => {
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse((saveSession(inputs()), storage.get(STORAGE_KEY)!)),
        samplerSources: {
          0: { sourceName: "a", wavRef: "../../etc" },
          1: { sourceName: "b", wavRef: 42 },
          99: { sourceName: "c", wavRef: "ok-id" },
          2: { sourceName: "d", wavRef: "ok-id" },
        },
      }),
    );
    const pending = loadSession()!.pendingSources;
    expect(pending.map((p) => (p.kind === "pt" ? p.slot : p.key))).toEqual([2]);
  });
});

describe(".retro project files", () => {
  it("still embed the audio, with or without a store", async () => {
    setSourceStore(createMemorySourceStore());
    const bytes = projectToBytes(
      inputs({ samplerSources: { 0: ptSource(wav(2000)) } }),
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("wavBase64");
    expect(text).not.toContain("wavRef");
    const back = projectFromBytes(bytes)!;
    expect(back.samplerSources[0]!.wav.channels[0]!.length).toBe(2000);
    expect(back.pendingSources).toEqual([]);
  });
});

describe("saveSessionAuto", () => {
  it("uses the store when there is one", async () => {
    const store = createMemorySourceStore();
    setSourceStore(store);
    const outcome = await saveSessionAuto(
      inputs({ samplerSources: { 0: ptSource(wav(BIG_FRAMES)) } }),
    );
    expect(outcome).toBe("ok");
    expect(store.map.size).toBe(1);
  });

  it("saves inline when there is none", async () => {
    setSourceStore(null);
    const outcome = await saveSessionAuto(
      inputs({ samplerSources: { 0: ptSource(wav(1000)) } }),
    );
    expect(outcome).toBe("ok");
    expect(storage.get(STORAGE_KEY)).toContain("wavBase64");
  });

  it("falls back to inline, and stops using the store, when it fails", async () => {
    const broken: SourceStore = {
      keys: async () => {
        throw new Error("IndexedDB unavailable");
      },
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    };
    setSourceStore(broken);
    expect(sourceStoreAvailable()).toBe(true);
    const outcome = await saveSessionAuto(
      inputs({
        song: { ...emptySong(), title: "kept" },
        samplerSources: { 0: ptSource(wav(BIG_FRAMES)) },
      }),
    );
    // Too big inline → the existing degraded path, song still current.
    expect(outcome).toBe("degraded");
    expect(loadSession()!.song.title).toBe("kept");
    expect(sourceStoreAvailable()).toBe(false);
  });
});

describe("queueSessionSave", () => {
  it("runs saves one at a time and keeps only the latest queued one", async () => {
    const store = createMemorySourceStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const keys = store.keys.bind(store);
    let first = true;
    store.keys = async () => {
      if (first) {
        first = false;
        await gate; // hold the first save mid-flight
      }
      return keys();
    };
    setSourceStore(store);

    const outcomes: SaveOutcome[] = [];
    const titled = (title: string) =>
      inputs({ song: { ...emptySong(), title } });
    const p1 = queueSessionSave(titled("one"), (o) => outcomes.push(o));
    void queueSessionSave(titled("two"), (o) => outcomes.push(o));
    void queueSessionSave(titled("three"), (o) => outcomes.push(o));
    release();
    await p1;

    expect(outcomes).toEqual(["ok", "ok"]); // "two" was superseded
    expect(loadSession()!.song.title).toBe("three");
  });

  it("a throwing outcome handler doesn't strand the queued save", async () => {
    // Regression: the error left the queued state behind, and the NEXT
    // call saved its own (newer) state and then the stale one on top.
    const store = createMemorySourceStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const keys = store.keys.bind(store);
    let first = true;
    store.keys = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return keys();
    };
    setSourceStore(store);

    const titled = (title: string) =>
      inputs({ song: { ...emptySong(), title } });
    let calls = 0;
    const p1 = queueSessionSave(titled("one"), () => {
      calls++;
      throw new Error("handler blew up");
    });
    void queueSessionSave(titled("two"), () => {});
    release();
    await expect(p1).rejects.toThrow("handler blew up");
    // The queued save still ran — it is newer than the one that threw.
    expect(calls).toBe(2);
    expect(loadSession()!.song.title).toBe("two");

    await queueSessionSave(titled("three"), () => {});
    expect(loadSession()!.song.title).toBe("three");
  });
});
