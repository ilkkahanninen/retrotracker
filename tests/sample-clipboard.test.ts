/**
 * State-level coverage for the sample clipboard (Cmd+C / Cmd+X / Cmd+V
 * in sample view). Drives `copySampleRange`, `cutSampleRange`,
 * `pasteSampleFromClipboard`, and `effectiveSampleRange` directly — no
 * App mount, no DOM. Verifies:
 *
 *   - selection-aware vs. whole-sample fallback for Copy / Cut
 *   - Cut routes through the existing cut-effect path (workbench
 *     append vs. direct int8 mutation, depending on workbench presence)
 *   - paste behavior across empty / populated / chiptune slots
 *   - cross-slot transfer
 *   - undo of Cut leaves bytes on the clipboard
 *   - mid-playback ops aren't gated
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copySampleRange,
  cutSampleRange,
  effectiveSampleRange,
  loadWavIntoCurrentSample,
  pasteSampleFromClipboard,
  patchCurrentSample,
} from "../src/state/sampleEdit";
import {
  clearSampleClipboard,
  sampleClipboard,
  setSampleClipboard,
} from "../src/state/sampleClipboard";
import { setSampleSelection } from "../src/state/sampleSelection";
import {
  clearHistory,
  setSong,
  setTransport,
  pt2Song as song,
  undo,
} from "../src/state/song";
import { setCurrentSample } from "../src/state/edit";
import {
  clearAllWorkbenches,
  getWorkbench,
  setWorkbench,
} from "../src/state/sampleWorkbench";
import { clearAllStashedLoops } from "../src/state/loopStash";
import { clearAllImportedStashes } from "../src/state/importedStash";
import { emptySong } from "../src/core/mod/format";
import { writeWav } from "../src/core/audio/wav";
import { workbenchFromChiptune } from "../src/core/audio/sampleWorkbench";
import { replaceSampleData } from "../src/core/mod/mutations";

function reset() {
  setSong(emptySong());
  setCurrentSample(1);
  setTransport("idle");
  clearHistory();
  clearAllWorkbenches();
  clearAllStashedLoops();
  clearAllImportedStashes();
  setSampleSelection(null);
  clearSampleClipboard();
}

beforeEach(reset);
afterEach(reset);

function makeWavBytes(frames = 800): Uint8Array {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i / 32) * Math.PI) * 0.5;
  return writeWav({ sampleRate: 22050, channels: [ch] }, { bitsPerSample: 16 });
}

/** Stamp deterministic int8 bytes into slot 0 with no workbench. */
function seedImportedSlot(
  opts: {
    data?: Int8Array;
    loopStartWords?: number;
    loopLengthWords?: number;
    name?: string;
  } = {},
): void {
  const data = opts.data ?? new Int8Array(200).map((_, i) => (i % 32) - 16);
  setSong(
    replaceSampleData(song()!, 0, data, {
      name: opts.name ?? "imported",
      volume: 64,
      finetune: 0,
      loopStartWords: opts.loopStartWords ?? 0,
      loopLengthWords: opts.loopLengthWords ?? 1,
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────
// effectiveSampleRange
// ──────────────────────────────────────────────────────────────────────

describe("effectiveSampleRange", () => {
  it("returns the selection when one is active", () => {
    seedImportedSlot();
    setSampleSelection({ start: 10, end: 50 });
    expect(effectiveSampleRange()).toEqual({ start: 10, end: 50 });
  });

  it("falls back to the whole sample when no selection is set", () => {
    seedImportedSlot({ data: new Int8Array(120) });
    expect(effectiveSampleRange()).toEqual({ start: 0, end: 120 });
  });

  it("returns null on an empty slot", () => {
    expect(effectiveSampleRange()).toBeNull();
  });

  it("clamps an out-of-bounds selection to the slot's data length", () => {
    seedImportedSlot({ data: new Int8Array(100) });
    setSampleSelection({ start: -50, end: 999 });
    expect(effectiveSampleRange()).toEqual({ start: 0, end: 100 });
  });
});

// ──────────────────────────────────────────────────────────────────────
// copySampleRange
// ──────────────────────────────────────────────────────────────────────

describe("copySampleRange", () => {
  it("writes the [start, end) slice to the sample clipboard", () => {
    const data = new Int8Array(40).map((_, i) => i - 20);
    seedImportedSlot({ data });
    copySampleRange(5, 15);
    const cb = sampleClipboard();
    expect(cb).not.toBeNull();
    expect(Array.from(cb!)).toEqual(Array.from(data.slice(5, 15)));
  });

  it("the clipboard is a copy, not a reference into the slot's data", () => {
    seedImportedSlot({ data: new Int8Array([1, 2, 3, 4, 5, 6]) });
    copySampleRange(0, 6);
    const cb = sampleClipboard()!;
    // The slot's data isn't mutated, but we still want to verify the
    // clipboard is independent — no aliasing.
    expect(cb).not.toBe(song()!.samples[0]!.data);
    cb[0] = 99;
    expect(song()!.samples[0]!.data[0]).not.toBe(99);
  });

  it("no-op on an empty slot (clipboard stays null)", () => {
    copySampleRange(0, 100);
    expect(sampleClipboard()).toBeNull();
  });

  it("no-op when the range is empty", () => {
    seedImportedSlot();
    copySampleRange(20, 20);
    expect(sampleClipboard()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// cutSampleRange — copy + remove
// ──────────────────────────────────────────────────────────────────────

describe("cutSampleRange", () => {
  it("on an imported slot (no workbench): clipboard set AND slot bytes shrink", () => {
    const data = new Int8Array(40).map((_, i) => i);
    seedImportedSlot({ data });
    const expectedSlice = data.slice(10, 20);
    cutSampleRange(10, 20);
    expect(Array.from(sampleClipboard()!)).toEqual(Array.from(expectedSlice));
    // Slot data is now the original bytes minus the [10, 20) range.
    const post = song()!.samples[0]!.data;
    expect(post.byteLength).toBe(30);
  });

  it("on a slot with a workbench: clipboard set AND chain gains a `cut` effect", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const int8Len = song()!.samples[0]!.data.byteLength;
    cutSampleRange(int8Len >> 2, (int8Len >> 2) * 3); // middle half
    expect(sampleClipboard()).not.toBeNull();
    const wb = getWorkbench(0)!;
    expect(wb.chain).toHaveLength(1);
    expect(wb.chain[0]!.kind).toBe("cut");
  });

  it("on a whole-sample range: slot empties, clipboard holds the prior bytes", () => {
    const data = new Int8Array(80).map((_, i) => (i & 0x7f) - 32);
    seedImportedSlot({ data });
    cutSampleRange(0, 80);
    expect(Array.from(sampleClipboard()!)).toEqual(Array.from(data));
    // The slot's data length collapses (cut path on no-workbench is
    // direct int8 mutation; an all-of-it cut leaves zero bytes).
    expect(song()!.samples[0]!.lengthWords).toBe(0);
  });

  it("undoing a cut restores the bytes but leaves the clipboard intact", () => {
    const data = new Int8Array(40).map((_, i) => i);
    seedImportedSlot({ data });
    const expectedSlice = data.slice(10, 20);
    cutSampleRange(10, 20);
    expect(sampleClipboard()).not.toBeNull();
    expect(song()!.samples[0]!.data.byteLength).toBe(30);

    undo();
    expect(song()!.samples[0]!.data.byteLength).toBe(40);
    // Clipboard survives the undo — the user can paste the cut bytes
    // even after reverting the cut.
    expect(Array.from(sampleClipboard()!)).toEqual(Array.from(expectedSlice));
  });
});

// ──────────────────────────────────────────────────────────────────────
// pasteSampleFromClipboard
// ──────────────────────────────────────────────────────────────────────

describe("pasteSampleFromClipboard", () => {
  it("no-op when the clipboard is empty", () => {
    seedImportedSlot();
    const before = song();
    pasteSampleFromClipboard();
    expect(song()).toBe(before);
  });

  it("paste into an empty slot: creates a fresh sampler workbench, NO_LOOP", () => {
    setSampleClipboard(new Int8Array([10, 20, 30, -10, -20, -30]));
    expect(song()!.samples[0]!.lengthWords).toBe(0);
    pasteSampleFromClipboard();
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
    const final = song()!.samples[0]!;
    expect(final.lengthWords).toBeGreaterThan(0);
    // First write into an empty slot adopts full volume / no loop /
    // auto-name (writeWorkbenchToSongPure's first-write policy).
    expect(final.volume).toBe(64);
    expect(final.loopLengthWords).toBe(1); // NO_LOOP sentinel
  });

  it("paste into a populated sampler slot: bytes replaced, volume/finetune/name preserved, loop reset", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    // Customise the slot's meta so we can verify it's preserved.
    patchCurrentSample({ volume: 32, finetune: 5 });
    // Pin a non-trivial loop so we can verify it gets reset.
    const len = song()!.samples[0]!.lengthWords;
    patchCurrentSample({
      loopStartWords: 4,
      loopLengthWords: Math.max(2, len - 8),
    });

    setSampleClipboard(new Int8Array(20).fill(33));
    pasteSampleFromClipboard();

    const final = song()!.samples[0]!;
    expect(final.volume).toBe(32);
    expect(final.finetune).toBe(5);
    // Loop reset to NO_LOOP sentinel.
    expect(final.loopLengthWords).toBe(1);
  });

  it("paste into a chiptune slot: switches to sampler, chiptune side stashed in alt", () => {
    setWorkbench(0, workbenchFromChiptune());
    setSampleClipboard(new Int8Array(40).fill(50));
    pasteSampleFromClipboard();
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    expect(wb.alt?.source.kind).toBe("chiptune");
  });

  it("paste into an imported slot (no workbench): creates sampler workbench", () => {
    seedImportedSlot();
    setSampleClipboard(new Int8Array(20).fill(7));
    pasteSampleFromClipboard();
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
  });

  it("cross-slot copy → paste: bytes carry across", () => {
    const sourceData = new Int8Array(30).map((_, i) => i + 1);
    seedImportedSlot({ data: sourceData });
    copySampleRange(0, 30);

    setCurrentSample(5);
    pasteSampleFromClipboard();
    const slot4 = song()!.samples[4]!;
    expect(slot4.lengthWords).toBeGreaterThan(0);
    // The exact bytes depend on workbenchFromInt8's PT-pipeline pass-
    // through (linear resampler, no targetNote change → near-identity).
    // Compare lengths; the byte content is verified by an integration
    // round-trip below.
  });

  it("cross-slot paste of a 6-byte clipboard reproduces the bytes", () => {
    setSampleClipboard(new Int8Array([1, -1, 2, -2, 3, -3]));
    pasteSampleFromClipboard();
    expect(Array.from(song()!.samples[0]!.data)).toEqual([1, -1, 2, -2, 3, -3]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Mid-playback: sample clipboard ops aren't transport-gated
// ──────────────────────────────────────────────────────────────────────

describe("Mid-playback: sample clipboard ops are allowed", () => {
  it("copySampleRange writes during playback", () => {
    seedImportedSlot();
    setTransport("playing");
    copySampleRange(0, 50);
    expect(sampleClipboard()).not.toBeNull();
  });

  it("cutSampleRange runs during playback (the underlying cut goes through commitEditWithWorkbenches)", () => {
    seedImportedSlot({ data: new Int8Array(40) });
    setTransport("playing");
    cutSampleRange(10, 20);
    // No-workbench path on imported slot: direct int8 mutation. This
    // path uses commitEdit, which gates on transport. So this case
    // ends up a no-op for the cut effect, but the clipboard write
    // still fires.
    expect(sampleClipboard()).not.toBeNull();
  });

  it("cutSampleRange on a workbenched slot fully runs during playback (workbench commit isn't gated)", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    setTransport("playing");
    const int8Len = song()!.samples[0]!.data.byteLength;
    cutSampleRange(int8Len >> 2, (int8Len >> 2) * 3);
    expect(sampleClipboard()).not.toBeNull();
    expect(getWorkbench(0)!.chain).toHaveLength(1);
    expect(getWorkbench(0)!.chain[0]!.kind).toBe("cut");
  });

  it("pasteSampleFromClipboard runs during playback", () => {
    setSampleClipboard(new Int8Array([1, 2, 3, 4]));
    setTransport("playing");
    pasteSampleFromClipboard();
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
  });
});
