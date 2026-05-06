import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent, waitFor } from "@solidjs/testing-library";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import {
  setSong,
  song,
  setTransport,
  setPlayMode,
  setPlayPos,
  clearHistory,
  undo,
  setDirty,
} from "../../src/state/song";
import {
  setCurrentSample,
  currentSample,
  setCurrentOctave,
  setEditStep,
} from "../../src/state/edit";
import { setView } from "../../src/state/view";
import {
  clearAllWorkbenches,
  getWorkbench,
} from "../../src/state/sampleWorkbench";
import { writeWav } from "../../src/core/audio/wav";
import { emptySong } from "../../src/core/mod/format";
import { writeModule } from "../../src/core/mod/writer";
import { projectToBytes } from "../../src/state/persistence";

function resetState(): void {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  setPlayMode(null);
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
  setDirty(false);
  setView("pattern");
  clearAllWorkbenches();
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
  vi.restoreAllMocks();
});

/** Build a deterministic WAV `File` with one tone-ish frame per sample. */
function makeWavFile(name: string, frames = 8): File {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = (i / frames - 0.5) * 0.5;
  const bytes = writeWav(
    { sampleRate: 22050, channels: [ch] },
    { bitsPerSample: 16 },
  );
  // Copy into a fresh ArrayBuffer so the BlobPart type narrows cleanly.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new File([buf], name, { type: "audio/wav" });
}

/**
 * jsdom's `DragEvent` constructor doesn't accept a `dataTransfer` init, and
 * the property is read-only on DragEvent. The portable workaround is to build
 * a plain Event and define the property directly — handlers only read
 * `e.dataTransfer?.files`, which doesn't care whether it's a real DataTransfer.
 */
function fireDrop(target: Element, files: File[]): void {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files } });
  fireEvent(target, ev);
}

function appRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".app");
  if (!el) throw new Error("app root not mounted");
  return el;
}

describe("drag-drop: WAV imports fan out across free slots", () => {
  it("a single WAV drop fills the current empty slot and creates a workbench", async () => {
    setSong(emptySong()); // every sample slot starts empty
    setCurrentSample(1); // slot index 0 in storage
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [makeWavFile("kick.wav", 8)]);

    await waitFor(() => {
      expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
    });
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
    // Selection lands on the slot we just filled (1-based UI numbering).
    expect(currentSample()).toBe(1);
  });

  it("skips the current slot when it is already populated and uses the next free one", async () => {
    // Pre-fill slot 0 with int8 data so its `lengthWords > 0` and the
    // drop handler steps past it to slot 1.
    const s = emptySong();
    s.samples[0] = {
      ...s.samples[0]!,
      name: "taken",
      lengthWords: 4,
      data: new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    setSong(s);
    setCurrentSample(1); // points at the occupied slot
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [makeWavFile("snare.wav", 8)]);

    await waitFor(() => {
      expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
    });
    // Original slot 0 untouched.
    expect(song()!.samples[0]!.name).toBe("taken");
    expect(Array.from(song()!.samples[0]!.data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // Selection follows the new slot (1-based: storage 1 → UI 2).
    expect(currentSample()).toBe(2);
    expect(getWorkbench(1)?.source.kind).toBe("sampler");
  });

  it("multiple WAV drops fill consecutive free slots in one shot", async () => {
    setSong(emptySong());
    setCurrentSample(1);
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [
      makeWavFile("one.wav", 8),
      makeWavFile("two.wav", 8),
      makeWavFile("three.wav", 8),
    ]);

    await waitFor(() => {
      expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
      expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
      expect(song()!.samples[2]!.lengthWords).toBeGreaterThan(0);
    });
    expect(getWorkbench(0)).toBeDefined();
    expect(getWorkbench(1)).toBeDefined();
    expect(getWorkbench(2)).toBeDefined();
    // Selection lands on the FIRST newly-filled slot.
    expect(currentSample()).toBe(1);
  });

  it("a single undo reverts the entire batch (one history entry)", async () => {
    setSong(emptySong());
    setCurrentSample(1);
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [
      makeWavFile("a.wav", 8),
      makeWavFile("b.wav", 8),
    ]);

    await waitFor(() => {
      expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
      expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
    });

    undo();

    expect(song()!.samples[0]!.lengthWords).toBe(0);
    expect(song()!.samples[1]!.lengthWords).toBe(0);
    // Workbench map snapshots are part of the history entry, so they roll
    // back too — both halves move together.
    expect(getWorkbench(0)).toBeUndefined();
    expect(getWorkbench(1)).toBeUndefined();
  });

  it("in sample view, a WAV drop replaces the current slot even when it is occupied", async () => {
    // Pattern-view drops onto a populated slot fan forward to the next free
    // slot (covered above). In sample view the user is actively editing the
    // selected slot, so a WAV drop is interpreted as "replace this sample"
    // rather than "append elsewhere".
    const s = emptySong();
    s.samples[0] = {
      ...s.samples[0]!,
      name: "taken",
      lengthWords: 4,
      data: new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    setSong(s);
    setCurrentSample(1);
    setView("sample");
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [makeWavFile("replacement.wav", 8)]);

    await waitFor(() => {
      // The drop overwrote slot 0's data — name is replaced and a workbench
      // is now associated with that slot.
      expect(getWorkbench(0)?.source.kind).toBe("sampler");
      expect(song()!.samples[0]!.name).not.toBe("taken");
    });
    // The slot 1 below stays empty — fanout did NOT happen.
    expect(song()!.samples[1]!.lengthWords).toBe(0);
    expect(getWorkbench(1)).toBeUndefined();
    // Selection stays on the slot the user was already editing.
    expect(currentSample()).toBe(1);
  });

  it("in sample view, extra WAVs from a multi-drop still fan forward after the current slot", async () => {
    // The first WAV anchors at the current slot (overwriting); the rest
    // fall onto subsequent free slots so a batch drop in sample view
    // doesn't silently discard the extras.
    const s = emptySong();
    s.samples[0] = {
      ...s.samples[0]!,
      name: "old",
      lengthWords: 4,
      data: new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    };
    setSong(s);
    setCurrentSample(1);
    setView("sample");
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [
      makeWavFile("first.wav", 8),
      makeWavFile("second.wav", 8),
    ]);

    await waitFor(() => {
      expect(getWorkbench(0)).toBeDefined();
      expect(getWorkbench(1)).toBeDefined();
    });
    expect(song()!.samples[0]!.name).not.toBe("old");
    expect(song()!.samples[1]!.lengthWords).toBeGreaterThan(0);
    expect(currentSample()).toBe(1);
  });

  it('emits a "skipped" error when there are more WAVs than free slots', async () => {
    // Fill every slot so the drop has nowhere to land except the very last
    // one — drop two files so one is skipped.
    const s = emptySong();
    for (let i = 0; i < s.samples.length - 1; i++) {
      s.samples[i] = {
        ...s.samples[i]!,
        lengthWords: 1,
        data: new Int8Array([0, 0]),
      };
    }
    setSong(s);
    setCurrentSample(1);
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [
      makeWavFile("fits.wav", 8),
      makeWavFile("overflows.wav", 8),
    ]);

    // We can't read the error signal from outside; assert via the side effect
    // instead — exactly one slot got filled, the second WAV was dropped.
    await waitFor(() => {
      expect(
        song()!.samples[s.samples.length - 1]!.lengthWords,
      ).toBeGreaterThan(0);
    });
    expect(getWorkbench(s.samples.length - 1)).toBeDefined();
  });
});

describe("drag-drop: routing by file extension", () => {
  it("a single .mod drop replaces the project, not the WAV-import path", async () => {
    // Build a .mod payload to drop. emptySong→writeModule round-trips fine.
    const seed = emptySong();
    seed.title = "DROPPED";
    const modBytes = writeModule(seed);
    const buf = new ArrayBuffer(modBytes.byteLength);
    new Uint8Array(buf).set(modBytes);
    const file = new File([buf], "dropped.mod", { type: "audio/x-mod" });

    setSong(emptySong()); // existing project the drop should replace
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [file]);

    await waitFor(() => {
      expect(song()!.title).toBe("DROPPED");
    });
    // Slot 0 untouched (no WAV-import side effect).
    expect(song()!.samples[0]!.lengthWords).toBe(0);
    expect(getWorkbench(0)).toBeUndefined();
  });

  it("a single .retro drop restores the project (existing project-load path)", async () => {
    const seed = emptySong();
    seed.title = "RETRO";
    const projectBytes = projectToBytes({
      song: seed,
      filename: "foo.retro",
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
    });
    const buf = new ArrayBuffer(projectBytes.byteLength);
    new Uint8Array(buf).set(projectBytes);
    const file = new File([buf], "foo.retro", { type: "application/json" });

    setSong(emptySong());
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [file]);

    await waitFor(() => {
      expect(song()!.title).toBe("RETRO");
    });
  });

  it("an unsupported file (.txt) is ignored — no slot mutation, no workbench", async () => {
    setSong(emptySong());
    setCurrentSample(1);
    const { container } = render(() => <App />);
    const txt = new File([new ArrayBuffer(0)], "notes.txt", {
      type: "text/plain",
    });

    fireDrop(appRoot(container), [txt]);

    // Give the async path a chance to run; nothing should mutate.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(song()!.samples[0]!.lengthWords).toBe(0);
    expect(getWorkbench(0)).toBeUndefined();
  });

  it("mixed drop (.mod + .wav) takes the WAV-batch path — .mod is filtered out", async () => {
    // Both files at once: the routing rule says "single .mod / .retro replaces
    // the project; otherwise WAVs". So a 2-file drop goes through the WAV
    // filter — only the .wav lands; the .mod is skipped (it'd be an unsupported
    // file in the WAV importer's eyes).
    setSong(emptySong());
    setCurrentSample(1);
    const { container } = render(() => <App />);

    const seed = emptySong();
    const modBytes = writeModule(seed);
    const modBuf = new ArrayBuffer(modBytes.byteLength);
    new Uint8Array(modBuf).set(modBytes);

    fireDrop(appRoot(container), [
      new File([modBuf], "extra.mod", { type: "audio/x-mod" }),
      makeWavFile("hat.wav", 8),
    ]);

    await waitFor(() => {
      expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
    });
    // Title still empty — the .mod did NOT replace the project.
    expect(song()!.title).toBe("");
  });
});

describe("drag-drop: blocked while playing", () => {
  it("drop is a no-op while the transport is playing", async () => {
    setSong(emptySong());
    setTransport("playing");
    const { container } = render(() => <App />);

    fireDrop(appRoot(container), [makeWavFile("blocked.wav", 8)]);

    // Give the async path a chance to run; nothing should land.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(song()!.samples[0]!.lengthWords).toBe(0);
    expect(getWorkbench(0)).toBeUndefined();
  });
});
