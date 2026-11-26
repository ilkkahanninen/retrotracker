/**
 * Regressions for:
 *  - pattern renames bypassing the undo history (and so being reverted by
 *    undoing any unrelated earlier edit),
 *  - a rejected file load desyncing transport and being reported as a
 *    successful load,
 *  - sampler sources being re-encoded on every project serialisation,
 *  - `.retro` filenames derived from `.xm` names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptySong } from "../src/core/mod/format";
import { setCell } from "../src/core/mod/mutations";
import { writeModule } from "../src/core/mod/writer";
import * as wavModule from "../src/core/audio/wav";
import type { WavData } from "../src/core/audio/wav";
import { renamePattern } from "../src/state/orderEdit";
import { patternNames } from "../src/state/patternNames";
import {
  deriveProjectFilename,
  projectFromBytes,
  projectToBytes,
  type SessionInputs,
} from "../src/state/persistence";
import {
  applyLoadedSession,
  error,
  filename,
  loadFile,
  setError,
} from "../src/state/session";
import { dismissSharedBanner, sharedBanner } from "../src/state/shareLoad";
import {
  canUndo,
  clearHistory,
  commitEdit,
  pt2Song,
  redo,
  setSong,
  setTransport,
  song,
  transport,
  undo,
} from "../src/state/song";

function reset() {
  setSong(null);
  setTransport("idle");
  clearHistory();
  setError(null);
  dismissSharedBanner();
}
beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

const file = (bytes: Uint8Array, name: string) =>
  new File([bytes as unknown as BlobPart], name);

describe("pattern rename is an undoable edit", () => {
  beforeEach(() => applyLoadedSession({ song: emptySong(), filename: null }));

  it("survives undoing an earlier, unrelated edit", () => {
    commitEdit((s) => setCell(s, 0, 0, 0, { period: 428, sample: 1 }));
    renamePattern(0, "intro");
    expect(patternNames()[0]).toBe("intro");

    undo(); // undoes the rename itself
    expect(patternNames()[0]).toBeUndefined();
    expect(pt2Song()!.patterns[0]!.rows[0]![0]!.period).toBe(428);

    redo();
    expect(patternNames()[0]).toBe("intro");
  });

  it("is not lost when a new edit follows an undo", () => {
    renamePattern(0, "intro");
    commitEdit((s) => setCell(s, 0, 0, 0, { period: 428, sample: 1 }));
    undo(); // the note
    expect(patternNames()[0]).toBe("intro");
    commitEdit((s) => setCell(s, 0, 1, 0, { period: 428, sample: 1 }));
    expect(patternNames()[0]).toBe("intro");
  });

  it("a no-op rename records nothing", () => {
    renamePattern(0, "intro");
    undo();
    expect(canUndo()).toBe(false);
    renamePattern(0, "   "); // clearing a name that isn't set
    expect(canUndo()).toBe(false);
    renamePattern(0, "intro");
    renamePattern(0, "intro");
    undo();
    expect(canUndo()).toBe(false);
  });

  it("blank clears the name, and that is undoable too", () => {
    renamePattern(0, "intro");
    renamePattern(0, "");
    expect(patternNames()[0]).toBeUndefined();
    undo();
    expect(patternNames()[0]).toBe("intro");
  });
});

describe("a rejected file load leaves the open song alone", () => {
  const garbage = new Uint8Array(2000).fill(7);

  it("resolves false, reports the error, keeps song / filename / transport", async () => {
    applyLoadedSession({ song: emptySong(), filename: "mine.mod" });
    setTransport("playing");
    const before = song();

    const ok = await loadFile(file(garbage, "broken.mod"));

    expect(ok).toBe(false);
    expect(song()).toBe(before);
    expect(filename()).toBe("mine.mod");
    // The bug: transport flipped to "idle" while the worklet kept playing.
    expect(transport()).toBe("playing");
    expect(error()).toContain("broken.mod");
  });

  it("rejects a corrupt .retro the same way", async () => {
    applyLoadedSession({ song: emptySong(), filename: "mine.mod" });
    const before = song();
    const ok = await loadFile(file(new Uint8Array([1, 2, 3]), "bad.retro"));
    expect(ok).toBe(false);
    expect(song()).toBe(before);
  });

  it("with no song open, transport falls back to idle", async () => {
    setTransport("ready");
    const ok = await loadFile(file(garbage, "broken.mod"));
    expect(ok).toBe(false);
    expect(transport()).toBe("idle");
  });

  it("resolves true for a good file and clears a previous error", async () => {
    setError("stale");
    const ok = await loadFile(file(writeModule(emptySong()), "good.mod"));
    expect(ok).toBe(true);
    expect(error()).toBeNull();
    expect(filename()).toBe("good.mod");
  });
});

describe("share banner", () => {
  it("is cleared when another song is loaded", async () => {
    // Raise the banner the way the share loader does, via its own module
    // state: load a song, then mark it shared.
    const mod = await import("../src/state/shareLoad");
    vi.stubGlobal("window", {
      location: { pathname: "/share/abcdefghijklmnopqrstuv" },
      history: { replaceState: () => {} },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "Content-Disposition": 'attachment; filename="shared.mod"',
        }),
        arrayBuffer: async () => writeModule(emptySong()).buffer,
      })),
    );
    await mod.detectAndLoadShareLink();
    vi.unstubAllGlobals();
    expect(sharedBanner()).not.toBeNull();

    applyLoadedSession({ song: emptySong(), filename: null });
    expect(sharedBanner()).toBeNull();
  });
});

describe("sampler source encoding is cached per WavData", () => {
  function wav(frames: number): WavData {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / 20) * 0.5;
    return { sampleRate: 44100, channels: [ch] };
  }
  const pt = {
    monoMix: "average" as const,
    targetNote: 12,
    resampleMode: "linear" as never,
    dither: false,
  };
  const inputs = (
    title: string,
    sources: SessionInputs["samplerSources"],
  ): SessionInputs => ({
    song: { ...emptySong(), title },
    filename: null,
    view: "pattern",
    cursor: { order: 0, row: 0, channel: 0, field: "note" },
    currentSample: 1,
    currentOctave: 2,
    editStep: 1,
    samplerSources: sources,
  });

  it("does not re-encode an unchanged source when the song changes", () => {
    const spy = vi.spyOn(wavModule, "writeWav");
    const a = wav(4000);
    const sources = { 0: { sourceName: "a.wav", wav: a, chain: [], pt } };

    const first = projectToBytes(inputs("one", sources));
    const encodes = spy.mock.calls.length;
    expect(encodes).toBe(1);

    // Simulates typing notes: new song reference, same sources.
    const second = projectToBytes(inputs("two", sources));
    projectToBytes(inputs("three", sources));
    expect(spy.mock.calls.length).toBe(encodes);

    // And the cached encoding is the real thing.
    const back = projectFromBytes(second)!;
    expect(back.samplerSources[0]!.wav.channels[0]!.length).toBe(4000);
    expect(first.length).toBe(second.length);
  });

  it("encodes a replaced source", () => {
    const spy = vi.spyOn(wavModule, "writeWav");
    const sources = (w: WavData) => ({
      0: { sourceName: "a.wav", wav: w, chain: [], pt },
    });
    projectToBytes(inputs("one", sources(wav(4000))));
    const bytes = projectToBytes(inputs("one", sources(wav(9000))));
    expect(spy.mock.calls.length).toBe(2);
    expect(
      projectFromBytes(bytes)!.samplerSources[0]!.wav.channels[0]!.length,
    ).toBe(9000);
  });
});

describe("deriveProjectFilename", () => {
  it("strips .xm like the other loadable extensions", () => {
    expect(deriveProjectFilename("song.xm", "")).toBe("song.retro");
    expect(deriveProjectFilename("Song.XM", "")).toBe("Song.retro");
    expect(deriveProjectFilename("song.mod", "")).toBe("song.retro");
    expect(deriveProjectFilename("song.retro", "")).toBe("song.retro");
  });
});
