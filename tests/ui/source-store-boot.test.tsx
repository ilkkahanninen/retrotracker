/**
 * Boot restore with sampler sources in the source store: the song comes
 * back synchronously, the sampler workbenches follow once their audio
 * has been read, and autosave must not run in between (it would write a
 * payload without the sources and sweep their audio out of the store).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import { App } from "../../src/App";
import type { WavData } from "../../src/core/audio/wav";
import { emptySong } from "../../src/core/mod/format";
import { replaceSampleData } from "../../src/core/mod/mutations";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import {
  clearSession,
  saveSessionWithStore,
} from "../../src/state/persistence";
import {
  clearAllWorkbenches,
  workbenches,
} from "../../src/state/sampleWorkbench";
import { applyLoadedSession, hydratingSources } from "../../src/state/session";
import {
  createMemorySourceStore,
  resetSourceStore,
  setSourceStore,
} from "../../src/state/sourceStore";
import { setCurrentSample } from "../../src/state/edit";
import { convertSlotToSampler } from "../../src/state/sampleEdit";
import {
  canUndo,
  clearHistory,
  commitEdit,
  dirty,
  undo,
  pt2Song,
  setSong,
  setTransport,
} from "../../src/state/song";
import { setView } from "../../src/state/view";
import {
  clearAllXmWorkbenches,
  xmWorkbenches,
} from "../../src/state/xmSampleWorkbench";

const STORAGE_KEY = "retrotracker:session:v1";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  clearAllWorkbenches();
  clearAllXmWorkbenches();
  setView("pattern");
  clearSession();
  resetSourceStore();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function wav(frames: number): WavData {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return { sampleRate: 44100, channels: [ch] };
}
const PT = {
  monoMix: "average" as const,
  targetNote: 12,
  resampleMode: "linear" as never,
  dither: false,
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedPtSession(
  store: ReturnType<typeof createMemorySourceStore>,
) {
  const song = replaceSampleData(
    { ...emptySong(), title: "restored" },
    0,
    new Int8Array(64).fill(20),
    { name: "kick", volume: 64 },
  );
  await saveSessionWithStore(
    {
      song,
      filename: "mine.mod",
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
      samplerSources: {
        0: { sourceName: "kick.wav", wav: wav(3000), chain: [], pt: PT },
      },
    },
    store,
  );
}

describe("boot restore with a source store", () => {
  it("restores the song at once and the sampler workbench shortly after", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    setSourceStore(store);

    render(() => <App />);
    // Song is there synchronously, playable from its rendered sample.
    expect(pt2Song()!.title).toBe("restored");
    expect(pt2Song()!.samples[0]!.data.length).toBe(64);

    await waitFor(() => expect(workbenches().get(0)).toBeDefined());
    const wb = workbenches().get(0)!;
    expect(wb.source.kind).toBe("sampler");
    if (wb.source.kind === "sampler") {
      expect(wb.source.sourceName).toBe("kick.wav");
      expect(wb.source.wav.channels[0]!.length).toBe(3000);
    }
    // Attaching the source is not an edit.
    expect(canUndo()).toBe(false);
    expect(dirty()).toBe(false);
    expect(hydratingSources()).toBe(false);
  });

  it("the autosave that follows still references the audio and keeps it", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const [id] = [...store.map.keys()];
    setSourceStore(store);

    render(() => <App />);
    await waitFor(() => expect(workbenches().get(0)).toBeDefined());
    await tick(400); // debounced autosave

    expect([...store.map.keys()]).toEqual([id]);
    const payload = localStorage.getItem(STORAGE_KEY)!;
    expect(payload).toContain(id!);
    expect(payload).not.toContain("wavBase64");
  });

  it("autosave waits while the audio is still being read", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const before = localStorage.getItem(STORAGE_KEY)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const get = store.get.bind(store);
    store.get = async (id) => {
      await gate;
      return get(id);
    };
    setSourceStore(store);

    render(() => <App />);
    expect(hydratingSources()).toBe(true);
    await tick(400); // longer than the autosave debounce
    // Nothing was written, nothing was swept.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(store.map.size).toBe(1);

    release();
    await waitFor(() => expect(workbenches().get(0)).toBeDefined());
    await tick(400);
    expect(store.map.size).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("wavRef");
  });

  it("does not attach audio to a different song loaded meanwhile", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const get = store.get.bind(store);
    store.get = async (id) => {
      await gate;
      return get(id);
    };
    setSourceStore(store);

    render(() => <App />);
    applyLoadedSession({ song: emptySong(), filename: "other.mod" });
    release();
    await waitFor(() => expect(hydratingSources()).toBe(false));
    expect(workbenches().size).toBe(0);
  });

  it("restores XM sampler workbenches too", async () => {
    const store = createMemorySourceStore();
    const song = { ...emptyXmSong(), title: "xm restored" };
    const inst = emptyXmInstrument();
    inst.samples[0]!.data = new Int8Array(64).fill(20);
    song.instruments = [inst];
    await saveSessionWithStore(
      {
        song,
        filename: "mine.xm",
        view: "pattern",
        cursor: { order: 0, row: 0, channel: 0, field: "note" },
        currentSample: 1,
        currentOctave: 2,
        editStep: 1,
        xmSamplerSources: {
          "1:0": {
            sourceName: "pad.wav",
            wav: wav(3000),
            chain: [],
            xm: { monoMix: "average", bitDepth: 16 },
          },
        },
      },
      store,
    );
    setSourceStore(store);

    render(() => <App />);
    await waitFor(() => expect(xmWorkbenches().get("1:0")).toBeDefined());
    expect(xmWorkbenches().get("1:0")!.xm.bitDepth).toBe(16);
  });

  /** A store whose reads wait for `release()`. */
  function gated(store: ReturnType<typeof createMemorySourceStore>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const get = store.get.bind(store);
    store.get = async (id) => {
      await gate;
      return get(id);
    };
    return release;
  }

  it("does not attach the source to a slot whose sample was replaced meanwhile", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const release = gated(store);
    setSourceStore(store);

    render(() => <App />);
    // The user replaces sample 1 while its source audio is still loading.
    commitEdit((s) =>
      replaceSampleData(s, 0, new Int8Array(32).fill(-9), { name: "other" }),
    );
    release();
    await waitFor(() => expect(hydratingSources()).toBe(false));
    // The new sample must not inherit the old one's source…
    expect(workbenches().get(0)).toBeUndefined();
    // …but the state it belonged to gets it back on undo.
    undo();
    expect(workbenches().get(0)).toBeDefined();
  });

  it("does not let a fresh sampler workbench shadow a source still loading", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const release = gated(store);
    setSourceStore(store);

    render(() => <App />);
    setCurrentSample(1);
    convertSlotToSampler();
    expect(workbenches().get(0)).toBeUndefined();
    release();
    await waitFor(() => expect(workbenches().get(0)).toBeDefined());
    const wb = workbenches().get(0)!;
    expect(wb.source.kind === "sampler" && wb.source.sourceName).toBe(
      "kick.wav",
    );
  });

  it("retries a read that fails once", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const get = store.get.bind(store);
    let calls = 0;
    store.get = async (id) => {
      if (calls++ === 0) throw new Error("transaction aborted");
      return get(id);
    };
    setSourceStore(store);

    render(() => <App />);
    await waitFor(() => expect(workbenches().get(0)).toBeDefined());
  });

  it("keeps the audio referenced when it could not be read at all", async () => {
    const store = createMemorySourceStore();
    await seedPtSession(store);
    const [id] = [...store.map.keys()];
    store.get = async () => {
      throw new Error("store unavailable");
    };
    setSourceStore(store);

    render(() => <App />);
    await waitFor(() => expect(hydratingSources()).toBe(false));
    expect(workbenches().get(0)).toBeUndefined();
    // Force an autosave after the failed read.
    commitEdit((s) => ({ ...s, title: "edited" }));
    await tick(400);

    // The audio survived the sweep and the payload still points at it,
    // so the next reload can try again.
    expect([...store.map.keys()]).toEqual([id]);
    expect(localStorage.getItem(STORAGE_KEY)).toContain(id!);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("kick.wav");
  });
});
