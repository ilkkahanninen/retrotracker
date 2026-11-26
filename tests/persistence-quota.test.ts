/**
 * Regression: when the autosave payload outgrew the localStorage quota
 * (large sampler sources), `saveSession` swallowed the error and left the
 * PREVIOUS session under the key — a reload silently rolled the user back
 * to whatever state last fit. It must now keep the stored song current
 * (dropping source audio if needed) and report what happened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptySong } from "../src/core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import type { WavData } from "../src/core/audio/wav";
import {
  loadSession,
  saveSession,
  type SessionInputs,
} from "../src/state/persistence";

const STORAGE_KEY = "retrotracker:session:v1";

/** Minimal localStorage with a hard cap on total stored characters. */
function installStorage(quotaChars: number): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      let used = 0;
      for (const [kk, vv] of m) if (kk !== k) used += kk.length + vv.length;
      if (used + k.length + v.length > quotaChars) {
        const e = new Error("The quota has been exceeded.");
        e.name = "QuotaExceededError";
        throw e;
      }
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

function wav(frames: number): WavData {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return { sampleRate: 44100, channels: [ch] };
}

function inputs(over: Partial<SessionInputs>): SessionInputs {
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

const PT = {
  monoMix: "average" as const,
  targetNote: 12,
  resampleMode: "linear" as never,
  dither: false,
};

/** ~200 KB of base64 — far over the 64 KB test quota, while an empty
 *  song's own payload (a few KB) fits comfortably. */
const BIG_FRAMES = 80_000;
const QUOTA = 64 * 1024;

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as { localStorage?: unknown }).localStorage;
});
afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = saved;
});

describe("saveSession under a storage quota", () => {
  it("reports ok and round-trips sampler sources when the payload fits", () => {
    installStorage(10 * 1024 * 1024);
    const outcome = saveSession(
      inputs({
        samplerSources: {
          0: { sourceName: "s.wav", wav: wav(1000), chain: [], pt: PT },
        },
      }),
    );
    expect(outcome).toBe("ok");
    expect(Object.keys(loadSession()!.samplerSources)).toEqual(["0"]);
  });

  it("keeps the stored song current when sampler sources overflow the quota", () => {
    installStorage(QUOTA);
    expect(
      saveSession(inputs({ song: { ...emptySong(), title: "before" } })),
    ).toBe("ok");

    const outcome = saveSession(
      inputs({
        song: { ...emptySong(), title: "after" },
        samplerSources: {
          0: { sourceName: "big.wav", wav: wav(BIG_FRAMES), chain: [], pt: PT },
        },
      }),
    );
    expect(outcome).toBe("degraded");

    const back = loadSession()!;
    // The bug: this used to read "before".
    expect(back.song.title).toBe("after");
    // Source audio is what got dropped to make it fit.
    expect(back.samplerSources).toEqual({});
  });

  it("degrades XM projects the same way", () => {
    installStorage(QUOTA);
    const song = { ...emptyXmSong(), title: "xm after" };
    song.instruments = [emptyXmInstrument()];
    const outcome = saveSession(
      inputs({
        song,
        xmSamplerSources: {
          "1:0": {
            sourceName: "big.wav",
            wav: wav(BIG_FRAMES),
            chain: [],
            xm: { monoMix: "average", bitDepth: 8 },
          },
        },
      }),
    );
    expect(outcome).toBe("degraded");
    const back = loadSession()!;
    expect(back.song.title).toBe("xm after");
    expect(back.xmSamplerSources).toEqual({});
  });

  it("keeps chiptune sources in the degraded payload", () => {
    installStorage(QUOTA);
    const ok = saveSession(inputs({}));
    expect(ok).toBe("ok");
    const outcome = saveSession(
      inputs({
        samplerSources: {
          0: { sourceName: "big.wav", wav: wav(BIG_FRAMES), chain: [], pt: PT },
        },
        patternNames: { 0: "intro" },
      }),
    );
    expect(outcome).toBe("degraded");
    expect(loadSession()!.patternNames).toEqual({ 0: "intro" });
  });

  it("reports failed when even the reduced payload does not fit", () => {
    const store = installStorage(QUOTA);
    saveSession(inputs({ song: { ...emptySong(), title: "before" } }));
    const stale = store.get(STORAGE_KEY);

    // Shrink the quota below the song-only payload.
    installStorage(16);
    const outcome = saveSession(
      inputs({
        samplerSources: {
          0: { sourceName: "big.wav", wav: wav(BIG_FRAMES), chain: [], pt: PT },
        },
      }),
    );
    expect(outcome).toBe("failed");
    expect(stale).toBeDefined();
  });

  it("reports failed when storage throws and there is nothing to drop", () => {
    installStorage(16);
    expect(saveSession(inputs({}))).toBe("failed");
  });
});
