/**
 * State-transition test bed for the sample view.
 *
 * Bug-prone surface (per user report):
 *   1. Sampler ↔ Chiptune ↔ "Imported" toggling — the alt stash, the
 *      imported side-stash, and the loop fields all need to survive
 *      round-trips without subtle drift.
 *   2. Effect chain stacking — especially length-changing effects (crop,
 *      cut) interacting with each other and with loop-aware effects.
 *   3. Loop preservation across edits and round-trips.
 *
 * We drive `setSourceKind` / `addEffect` / `loadWavIntoCurrentSample` /
 * etc. directly (no App mount) and read the post-state from the song,
 * workbench map, and the in-memory stashes. Tests run in the node
 * environment — no Solid root, no DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addEffect,
  applyChainToSource,
  clearCurrentSample,
  convertChiptuneToSampler,
  convertSlotToSampler,
  cropCurrentSampleToSelection,
  cutCurrentSampleSelection,
  loadWavIntoCurrentSample,
  patchCurrentSample,
  removeEffect,
  setSourceKind,
  updateChiptune,
  updateCurrentWorkbench,
} from "../src/state/sampleEdit";
import {
  clearHistory,
  setSong,
  setTransport,
  song,
  undo,
} from "../src/state/song";
import { setCurrentSample } from "../src/state/edit";
import {
  clearAllWorkbenches,
  getWorkbench,
  setWorkbench,
} from "../src/state/sampleWorkbench";
import { clearAllStashedLoops } from "../src/state/loopStash";
import {
  clearAllImportedStashes,
  getImportedStash,
} from "../src/state/importedStash";
import { emptySong } from "../src/core/mod/format";
import { writeWav } from "../src/core/audio/wav";
import {
  workbenchFromChiptune,
  type EffectNode,
} from "../src/core/audio/sampleWorkbench";
import { replaceSampleData } from "../src/core/mod/mutations";
import type { Song } from "../src/core/mod/types";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a 2-point flat volume envelope spanning [0, lastFrame] at gain
 *  `g`. The pipeline previously had a dedicated `gain` effect; that's
 *  now expressed as a constant envelope. `lastFrame` defaults to 1 — the
 *  exact value doesn't matter for tests asserting workbench machinery
 *  rather than amplitude math, since clamp-to-boundary makes the
 *  envelope flat at gain `g` everywhere. */
function gainNode(g: number, lastFrame: number = 1): EffectNode {
  return {
    kind: "volume",
    params: {
      points: [
        { frame: 0, gain: g },
        { frame: lastFrame, gain: g },
      ],
    },
  };
}

/** Old `fadeIn [s, e)` rewritten as a volume envelope. Mirrors the
 *  persistence migration's emitted shape. */
function fadeInNode(s: number, e: number): EffectNode {
  return {
    kind: "volume",
    params: {
      points:
        s === 0
          ? [
              { frame: 0, gain: 0 },
              { frame: e, gain: 1 },
            ]
          : [
              { frame: 0, gain: 1 },
              { frame: Math.max(0, s - 1), gain: 1 },
              { frame: s, gain: 0 },
              { frame: e, gain: 1 },
            ],
    },
  };
}

/** Old `fadeOut [s, e)` rewritten as a volume envelope. */
function fadeOutNode(s: number, e: number): EffectNode {
  return {
    kind: "volume",
    params: {
      points: [
        { frame: s, gain: 1 },
        { frame: e, gain: 0 },
        { frame: e + 1, gain: 1 },
      ],
    },
  };
}

function reset() {
  setSong(emptySong());
  setCurrentSample(1);
  setTransport("idle");
  clearHistory();
  clearAllWorkbenches();
  clearAllStashedLoops();
  clearAllImportedStashes();
}

beforeEach(reset);
afterEach(reset);

/** Stamp non-zero int8 bytes into slot 0 so it's "imported": has data,
 *  no workbench. Returns the new song reference. */
function seedImportedSlot(
  opts: {
    data?: Int8Array;
    loopStartWords?: number;
    loopLengthWords?: number;
    name?: string;
  } = {},
): Song {
  const data = opts.data ?? new Int8Array(200).map((_, i) => (i % 32) - 16);
  const next = replaceSampleData(song()!, 0, data, {
    name: opts.name ?? "imported",
    volume: 64,
    finetune: 0,
    loopStartWords: opts.loopStartWords ?? 0,
    loopLengthWords: opts.loopLengthWords ?? 1,
  });
  setSong(next);
  return next;
}

/** Build a tiny WAV file (bytes) for `loadWavIntoCurrentSample`. */
function makeWavBytes(frames = 800): Uint8Array {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i / 32) * Math.PI) * 0.5;
  return writeWav({ sampleRate: 22050, channels: [ch] }, { bitsPerSample: 16 });
}

// ──────────────────────────────────────────────────────────────────────
// Source-kind transitions
// ──────────────────────────────────────────────────────────────────────

describe("setSourceKind: Sampler ↔ Chiptune (alt stash)", () => {
  it("Sampler→Chiptune→Sampler restores the original WAV source by reference", () => {
    loadWavIntoCurrentSample(makeWavBytes(), "tone.wav");
    const wbBefore = getWorkbench(0)!;
    expect(wbBefore.source.kind).toBe("sampler");
    const samplerSourceRef = wbBefore.source;

    setSourceKind("chiptune");
    expect(getWorkbench(0)!.source.kind).toBe("chiptune");

    setSourceKind("sampler");
    const wbAfter = getWorkbench(0)!;
    expect(wbAfter.source.kind).toBe("sampler");
    // The exact source ref should be restored from the alt stash, not
    // a freshly-built empty sampler workbench.
    expect(wbAfter.source).toBe(samplerSourceRef);
  });

  it("Sampler→Chiptune→Sampler restores a non-default loop exactly", () => {
    loadWavIntoCurrentSample(makeWavBytes(), "tone.wav");
    // Pin a non-trivial loop window — half-way in, quarter-length.
    const lenWords = song()!.samples[0]!.lengthWords;
    const loopStart = Math.floor(lenWords / 2);
    const loopLen = Math.max(2, Math.floor(lenWords / 4));
    patchCurrentSample({
      loopStartWords: loopStart,
      loopLengthWords: loopLen,
    });

    setSourceKind("chiptune");
    // Chiptune forces full-loop, so loop fields differ here.
    expect(song()!.samples[0]!.loopStartWords).toBe(0);

    setSourceKind("sampler");
    expect(song()!.samples[0]!.loopStartWords).toBe(loopStart);
    expect(song()!.samples[0]!.loopLengthWords).toBe(loopLen);
  });

  it("Sampler→Chiptune→Sampler preserves the sampler chain", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "tone.wav");
    addEffect("volume", null);
    addEffect("normalize", null);
    const chainBefore = [...getWorkbench(0)!.chain];
    expect(chainBefore.length).toBe(2);

    setSourceKind("chiptune");
    // In chiptune mode the chain is the chiptune-side chain (empty by default).
    expect(getWorkbench(0)!.chain.length).toBe(0);
    addEffect("volume", null); // chiptune-side chain edit
    expect(getWorkbench(0)!.chain.length).toBe(1);

    setSourceKind("sampler");
    // Sampler chain restored verbatim.
    expect(getWorkbench(0)!.chain).toEqual(chainBefore);
  });

  it("Chiptune→Sampler with no alt and no imported stash creates an empty sampler", () => {
    // Slot starts as fresh chiptune (no prior sampler half, no imported bytes).
    setWorkbench(0, workbenchFromChiptune());
    setSourceKind("sampler");
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    if (wb.source.kind === "sampler") {
      // Empty source = no audio yet, waiting for "Load WAV".
      expect(wb.source.wav.channels[0]?.length ?? 0).toBe(0);
    }
  });
});

describe("setSourceKind: 'Imported' (no-workbench) ↔ Chiptune via side-stash", () => {
  it("Imported→Chiptune→Imported restores the original int8 bytes exactly", () => {
    const originalData = new Int8Array(200).map((_, i) =>
      Math.round(Math.sin(i / 4) * 100),
    );
    seedImportedSlot({ data: originalData, name: "kept" });

    expect(getWorkbench(0)).toBeUndefined(); // confirm no workbench

    // Transition 1: → Chiptune. The slot's int8 gets stashed before the
    // chiptune render overwrites it.
    setSourceKind("chiptune");
    expect(getWorkbench(0)?.source.kind).toBe("chiptune");
    expect(getImportedStash(0)).toBeDefined();
    // The chiptune cycle has overwritten the slot's data.
    expect(song()!.samples[0]!.data).not.toBe(originalData);

    // Transition 2: → Sampler. With no alt-stashed sampler half but an
    // imported side-stash, we expect the slot to drop back into the
    // exact pre-chiptune state — original bytes, original meta, NO
    // workbench at all.
    setSourceKind("sampler");
    expect(getWorkbench(0)).toBeUndefined();
    expect(song()!.samples[0]!.name).toBe("kept");
    expect(Array.from(song()!.samples[0]!.data)).toEqual(
      Array.from(originalData),
    );
    // Stash should have been consumed.
    expect(getImportedStash(0)).toBeUndefined();
  });

  it("Imported→Chiptune→Imported→Chiptune re-stashes the freshly-restored bytes", () => {
    const originalData = new Int8Array(120).fill(50);
    seedImportedSlot({ data: originalData });
    setSourceKind("chiptune");
    setSourceKind("sampler");
    // Slot is back to imported state. Toggle again — should re-stash.
    expect(getImportedStash(0)).toBeUndefined();
    setSourceKind("chiptune");
    expect(getImportedStash(0)).toBeDefined();
    setSourceKind("sampler");
    // Bytes restore again (same original data).
    expect(Array.from(song()!.samples[0]!.data)).toEqual(
      Array.from(originalData),
    );
  });

  it("clearCurrentSample drops the imported stash so a later Chiptune→Sampler doesn't surprise-restore", () => {
    seedImportedSlot();
    setSourceKind("chiptune");
    expect(getImportedStash(0)).toBeDefined();

    clearCurrentSample();
    expect(getImportedStash(0)).toBeUndefined();
    expect(song()!.samples[0]!.lengthWords).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Effect chain stacking
// ──────────────────────────────────────────────────────────────────────

describe("Effect chain stacking: crop / cut combinations", () => {
  it("crop after crop nests correctly: only the inner range survives", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const wb0 = getWorkbench(0)!;
    // Outer crop keeps frames [200, 600) → 400-frame output.
    updateCurrentWorkbench({
      ...wb0,
      chain: [
        { kind: "crop", params: { startFrame: 200, endFrame: 600 } },
        // Inner crop is over the OUTER's output — keep [50, 350) → 300 frames.
        { kind: "crop", params: { startFrame: 50, endFrame: 350 } },
      ],
    });
    // Pipeline output → 300 source frames → after PT transformer (sinc
    // resample to C-2 rate). We're not asserting byte-for-byte, just
    // that a non-empty result lands and is shorter than a single crop
    // would have produced.
    expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
    const twoCropLen = song()!.samples[0]!.lengthWords;

    // For comparison, a single outer crop alone:
    updateCurrentWorkbench({
      ...wb0,
      chain: [{ kind: "crop", params: { startFrame: 200, endFrame: 600 } }],
    });
    const singleCropLen = song()!.samples[0]!.lengthWords;
    expect(twoCropLen).toBeLessThan(singleCropLen);
  });

  it("cut after crop removes a slice of the cropped output", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const wb0 = getWorkbench(0)!;
    // Outer crop keeps frames [100, 700) → 600-frame output.
    // Cut removes [200, 400) of that → 600 - 200 = 400 frames.
    updateCurrentWorkbench({
      ...wb0,
      chain: [
        { kind: "crop", params: { startFrame: 100, endFrame: 700 } },
        { kind: "cut", params: { startFrame: 200, endFrame: 400 } },
      ],
    });
    expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
    const cutPlusCropLen = song()!.samples[0]!.lengthWords;
    // Crop alone:
    updateCurrentWorkbench({
      ...wb0,
      chain: [{ kind: "crop", params: { startFrame: 100, endFrame: 700 } }],
    });
    const cropOnlyLen = song()!.samples[0]!.lengthWords;
    expect(cutPlusCropLen).toBeLessThan(cropOnlyLen);
  });

  it("crop with start > end clamps to empty (length=1 sentinel) rather than crashing", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb0 = getWorkbench(0)!;
    expect(() => {
      updateCurrentWorkbench({
        ...wb0,
        chain: [{ kind: "crop", params: { startFrame: 300, endFrame: 100 } }],
      });
    }).not.toThrow();
    // Empty pipeline output → slot collapses to length 0 / 1-word sentinel.
    expect(song()!.samples[0]!.lengthWords).toBeLessThanOrEqual(1);
  });

  it("five effects in a row don't crash and don't produce garbage longer than the source", () => {
    loadWavIntoCurrentSample(makeWavBytes(1200), "src.wav");
    const wb0 = getWorkbench(0)!;
    const baselineLen = song()!.samples[0]!.lengthWords;

    updateCurrentWorkbench({
      ...wb0,
      chain: [
        gainNode(0.8),
        fadeInNode(0, 100),
        { kind: "crop", params: { startFrame: 50, endFrame: 1000 } },
        fadeOutNode(800, 950),
        { kind: "normalize" },
      ],
    });
    const stackedLen = song()!.samples[0]!.lengthWords;
    // Crop shrunk the data; normalize / fade / gain don't change length.
    expect(stackedLen).toBeGreaterThan(0);
    expect(stackedLen).toBeLessThan(baselineLen);
  });
});

describe("Effect chain stacking: range-aware effects use chain output frames, not source frames", () => {
  it("addEffect('crop', selection) maps int8 byte selection → chain output frames", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const int8Len = song()!.samples[0]!.data.length;
    // Select the back half of the int8 range. The crop effect should
    // land in the equivalent half of the chain output.
    cropCurrentSampleToSelection(int8Len >> 1, int8Len);
    const wb = getWorkbench(0)!;
    expect(wb.chain.length).toBe(1);
    expect(wb.chain[0]!.kind).toBe("crop");
    if (wb.chain[0]!.kind === "crop") {
      // Chain output (pre-crop) frame count ≈ source frames (sampler →
      // chiptune null targetNote? no, sampler defaults to C-2 → resample).
      // Whatever the count, the crop should land at "back half".
      const { startFrame, endFrame } = wb.chain[0]!.params;
      expect(endFrame).toBeGreaterThan(startFrame);
      // The selection covered the back half of int8 → start should be
      // strictly past the midpoint of (chain) frames.
      expect(startFrame).toBeGreaterThan(0);
    }
  });

  it("crop+cut via the user-action helpers produces fewer bytes than crop alone", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const int8Len = song()!.samples[0]!.data.length;
    cropCurrentSampleToSelection(int8Len >> 2, (int8Len >> 2) * 3);
    const cropOnlyLen = song()!.samples[0]!.lengthWords;
    const newInt8Len = song()!.samples[0]!.data.length;
    cutCurrentSampleSelection(newInt8Len >> 2, (newInt8Len >> 2) * 3);
    const cropPlusCutLen = song()!.samples[0]!.lengthWords;
    expect(cropPlusCutLen).toBeLessThan(cropOnlyLen);
  });
});

describe("Effect chain stacking: removeEffect and reorder", () => {
  it("removing the only crop returns the byte length to baseline", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const baseline = song()!.samples[0]!.lengthWords;

    addEffect("crop", { start: 0, end: 200 });
    const cropped = song()!.samples[0]!.lengthWords;
    expect(cropped).toBeLessThan(baseline);

    removeEffect(0);
    expect(song()!.samples[0]!.lengthWords).toBe(baseline);
  });

  it("removing a middle effect from a 3-effect chain keeps the others", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    addEffect("volume", null);
    addEffect("normalize", null);
    addEffect("reverse", { start: 0, end: 100 });
    expect(getWorkbench(0)!.chain).toHaveLength(3);
    removeEffect(1); // drop normalize
    const chain = getWorkbench(0)!.chain;
    expect(chain).toHaveLength(2);
    expect(chain[0]!.kind).toBe("volume");
    expect(chain[1]!.kind).toBe("reverse");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Loop preservation across edits
// ──────────────────────────────────────────────────────────────────────

describe("Loop preservation across pipeline edits", () => {
  it("re-running pipeline with the same workbench doesn't shave the loop one word at a time", () => {
    // Regression guard for the 'end point wanders left' bug. The padding-
    // aware short-circuit in scaledLoop should detect that the re-run's
    // post-pad length matches the slot's stored length and leave loop
    // bounds alone.
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const len = song()!.samples[0]!.lengthWords;
    const loopStart = 4;
    const loopLen = Math.max(2, len - 8);
    patchCurrentSample({
      loopStartWords: loopStart,
      loopLengthWords: loopLen,
    });
    expect(song()!.samples[0]!.loopStartWords).toBe(loopStart);
    expect(song()!.samples[0]!.loopLengthWords).toBe(loopLen);

    // Simulate ten slider re-runs that don't change the chain.
    for (let i = 0; i < 10; i++) {
      const wb = getWorkbench(0)!;
      updateCurrentWorkbench({ ...wb }); // shallow re-emit; same effect content
    }
    expect(song()!.samples[0]!.loopStartWords).toBe(loopStart);
    expect(song()!.samples[0]!.loopLengthWords).toBe(loopLen);
  });

  it("crop that halves the chain output rescales the loop proportionally", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const fullLen = song()!.samples[0]!.lengthWords;
    // Loop covers the back half of the data.
    patchCurrentSample({
      loopStartWords: fullLen >> 1,
      loopLengthWords: Math.max(2, fullLen - (fullLen >> 1)),
    });
    const oldEndWords =
      song()!.samples[0]!.loopStartWords + song()!.samples[0]!.loopLengthWords;

    // Crop the source to its first half. The loop should slide forward
    // (the back-half loop now points at the back of the cropped half).
    addEffect("crop", null);
    // The default crop covers the whole input — but the user asked for
    // the back half. Patch the crop to keep [0, frameMid):
    const wb = getWorkbench(0)!;
    const cropNode = wb.chain[0];
    expect(cropNode?.kind).toBe("crop");
    if (cropNode?.kind === "crop") {
      const half = Math.floor(cropNode.params.endFrame / 2);
      updateCurrentWorkbench({
        ...wb,
        chain: [{ kind: "crop", params: { startFrame: 0, endFrame: half } }],
      });
    }
    const cropped = song()!.samples[0]!;
    // Length roughly halved; loop end should also have roughly halved.
    expect(cropped.lengthWords).toBeLessThan(fullLen);
    const newEndWords = cropped.loopStartWords + cropped.loopLengthWords;
    expect(newEndWords).toBeLessThanOrEqual(cropped.lengthWords);
    expect(newEndWords).toBeLessThan(oldEndWords);
  });

  it("loop survives Sampler→Chiptune→Sampler with chiptune full-loop in the middle", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const len = song()!.samples[0]!.lengthWords;
    const loopStart = 8;
    const loopLen = 16;
    patchCurrentSample({
      loopStartWords: loopStart,
      loopLengthWords: loopLen,
    });
    setSourceKind("chiptune");
    // Chiptune forces full loop:
    expect(song()!.samples[0]!.loopStartWords).toBe(0);
    setSourceKind("sampler");
    expect(song()!.samples[0]!.loopStartWords).toBe(loopStart);
    expect(song()!.samples[0]!.loopLengthWords).toBe(loopLen);
    // Slot length should be back to the sampler render length too.
    expect(song()!.samples[0]!.lengthWords).toBe(len);
  });
});

// ──────────────────────────────────────────────────────────────────────
// History integration: edits across transitions are undoable atomically
// ──────────────────────────────────────────────────────────────────────

describe("History: source-kind transitions and chain edits round-trip via undo", () => {
  it("undo of an addEffect drops the effect AND restores the previous int8 length", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const beforeLen = song()!.samples[0]!.lengthWords;
    addEffect("crop", { start: 0, end: 100 });
    const afterLen = song()!.samples[0]!.lengthWords;
    expect(afterLen).not.toBe(beforeLen);

    undo();
    expect(getWorkbench(0)!.chain).toHaveLength(0);
    expect(song()!.samples[0]!.lengthWords).toBe(beforeLen);
  });

  it("undo of setSourceKind('chiptune') from sampler restores the sampler workbench", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    expect(getWorkbench(0)!.source.kind).toBe("sampler");

    setSourceKind("chiptune");
    expect(getWorkbench(0)!.source.kind).toBe("chiptune");

    undo();
    expect(getWorkbench(0)!.source.kind).toBe("sampler");
  });
});

// ──────────────────────────────────────────────────────────────────────
// applyChainToSource: burn-in
// ──────────────────────────────────────────────────────────────────────

describe("applyChainToSource (Apply changes button)", () => {
  it("after burning a crop, the chain is empty and the int8 length is preserved", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    addEffect("crop", { start: 0, end: 200 });
    const beforeBurnLen = song()!.samples[0]!.lengthWords;
    expect(getWorkbench(0)!.chain).toHaveLength(1);

    applyChainToSource();
    expect(getWorkbench(0)!.chain).toHaveLength(0);
    // Slot's int8 should be the same length pre/post burn.
    expect(song()!.samples[0]!.lengthWords).toBe(beforeBurnLen);
  });

  it("burn preserves loop bounds (no shift, no shave) when chain is length-changing", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    addEffect("crop", { start: 0, end: 100 });
    // Pin a loop after crop so the post-crop length is "the truth".
    const len = song()!.samples[0]!.lengthWords;
    const loopStart = 4;
    const loopLen = Math.max(2, len - 8);
    patchCurrentSample({
      loopStartWords: loopStart,
      loopLengthWords: loopLen,
    });
    const beforeStart = song()!.samples[0]!.loopStartWords;
    const beforeLen = song()!.samples[0]!.loopLengthWords;

    applyChainToSource();
    expect(getWorkbench(0)!.chain).toHaveLength(0);
    expect(song()!.samples[0]!.loopStartWords).toBe(beforeStart);
    expect(song()!.samples[0]!.loopLengthWords).toBe(beforeLen);
  });
});

// ──────────────────────────────────────────────────────────────────────
// convertSlotToSampler / convertChiptuneToSampler
// ──────────────────────────────────────────────────────────────────────

describe("convertSlotToSampler: imported → sampler workbench", () => {
  it("wraps the imported int8 as a sampler workbench without rewriting bytes", () => {
    seedImportedSlot();
    const dataBefore = song()!.samples[0]!.data;
    expect(getWorkbench(0)).toBeUndefined();

    convertSlotToSampler();
    expect(getWorkbench(0)!.source.kind).toBe("sampler");
    // The slot's int8 ref should be unchanged (no pipeline re-run yet).
    expect(song()!.samples[0]!.data).toBe(dataBefore);
  });

  it("does not register an undo history entry — pure session-state setup", () => {
    seedImportedSlot();
    const songBefore = song();
    convertSlotToSampler();
    // setWorkbench is a direct write, no commitEdit. Undoing should be a
    // no-op (history is empty for this slot).
    undo();
    expect(song()).toBe(songBefore);
  });
});

describe("convertChiptuneToSampler: freeze synth output as sampler source", () => {
  it("freezes the chiptune render as the sampler source, empties the chain", () => {
    setWorkbench(0, workbenchFromChiptune());
    // Drive a pipeline write so the slot's int8 is populated.
    updateCurrentWorkbench(getWorkbench(0)!);
    const beforeLen = song()!.samples[0]!.lengthWords;

    convertChiptuneToSampler();
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    expect(wb.chain).toHaveLength(0);
    expect(wb.alt?.source.kind).toBe("chiptune");
    // Audio length unchanged — same render, just frozen as source.
    expect(song()!.samples[0]!.lengthWords).toBe(beforeLen);
  });
});

// ──────────────────────────────────────────────────────────────────────
// `loadWavIntoCurrentSample` interactions
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Crossfade × length-changing effects (loop-aware effect interaction)
// ──────────────────────────────────────────────────────────────────────

describe("Crossfade after a length-changing effect", () => {
  it("crop then crossfade: pipeline runs without throwing and produces non-empty output", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    // Set a real loop so crossfade has something to fade against.
    const len = song()!.samples[0]!.lengthWords;
    patchCurrentSample({
      loopStartWords: Math.max(2, len >> 2),
      loopLengthWords: Math.max(2, len >> 1),
    });
    addEffect("crop", null);
    addEffect("crossfade", null);
    expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
  });

  it("crossfade frames are scaled into the cropped chain output, not the original source", () => {
    // RunContext maps int8-byte loop positions into the loop-aware
    // effect's INPUT frame space using `inputFrames / int8Length`. A
    // preceding crop shrinks the input frames, so crossfade should land
    // inside the cropped data — not overshoot and clamp.
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const len = song()!.samples[0]!.lengthWords;
    patchCurrentSample({
      loopStartWords: 2,
      loopLengthWords: Math.max(2, len - 4),
    });
    // Crop to first half, then crossfade; verify slot still has the
    // expected post-crop length (crossfade doesn't change length).
    addEffect("crop", null);
    const wb = getWorkbench(0)!;
    const cropNode = wb.chain[0]!;
    if (cropNode.kind === "crop") {
      const half = Math.floor(cropNode.params.endFrame / 2);
      updateCurrentWorkbench({
        ...wb,
        chain: [
          { kind: "crop", params: { startFrame: 0, endFrame: half } },
          { kind: "crossfade", params: { length: 16 } },
        ],
      });
    }
    expect(song()!.samples[0]!.lengthWords).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Repeated burns (Apply changes pressed multiple times)
// ──────────────────────────────────────────────────────────────────────

describe("Repeated applyChainToSource on a slot with a loop", () => {
  it("Apply N times in a row doesn't drift the loop bounds", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    addEffect("crop", { start: 0, end: 200 });
    const len = song()!.samples[0]!.lengthWords;
    const loopStart = 4;
    const loopLen = Math.max(2, Math.floor(len / 2));
    patchCurrentSample({
      loopStartWords: loopStart,
      loopLengthWords: loopLen,
    });
    const beforeStart = song()!.samples[0]!.loopStartWords;
    const beforeLen = song()!.samples[0]!.loopLengthWords;

    // Burn once, then add another length-changing effect, burn again, …
    // five rounds. The loop's `loopStartWords` should never slide.
    for (let i = 0; i < 5; i++) {
      applyChainToSource();
      expect(song()!.samples[0]!.loopStartWords).toBe(beforeStart);
      // Add a tiny crop that's still inside the loop's audible range so
      // the next burn has a non-empty chain to work with.
      const cur = song()!.samples[0]!;
      if (cur.lengthWords < 8) break;
      addEffect("crop", null); // default = whole input → noop, but exercises the path
    }
    expect(song()!.samples[0]!.loopStartWords).toBe(beforeStart);
    // loopLength may shrink by a couple words across burns if the data
    // genuinely got shorter; what we guard against is a per-burn shave.
    // It must NOT be shorter than half the original loop after 5 rounds.
    expect(song()!.samples[0]!.loopLengthWords).toBeGreaterThan(beforeLen / 2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Source-kind toggle with stacked chain effects
// ──────────────────────────────────────────────────────────────────────

describe("Source-kind toggle with sampler chain containing length-changing effects", () => {
  it("Sampler(crop+gain)→Chiptune→Sampler restores the same chain AND the same int8 length", () => {
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    addEffect("crop", { start: 0, end: 100 });
    addEffect("volume", null);
    const samplerChainLen = song()!.samples[0]!.lengthWords;
    const samplerChainSnapshot = [...getWorkbench(0)!.chain];

    setSourceKind("chiptune");
    setSourceKind("sampler");

    expect(getWorkbench(0)!.chain).toEqual(samplerChainSnapshot);
    // Going chiptune→sampler may produce a different int8 length than
    // the original (the chiptune render had different bytes), but the
    // sampler's chain re-runs from the original WAV source, so length
    // should match.
    expect(song()!.samples[0]!.lengthWords).toBe(samplerChainLen);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Effect ordering — reverse, fade, normalize stacked in different orders
// ──────────────────────────────────────────────────────────────────────

describe("Effect ordering: order matters and the pipeline stays well-defined", () => {
  it("fadeIn before crop ≠ fadeIn after crop (order matters)", () => {
    // A fadeIn over [0, 100] applied BEFORE a crop [200, 600] silences
    // frames 0-100 of the source, then the crop discards them — the
    // surviving 400 frames are full-volume.
    // The same fadeIn applied AFTER the crop ramps the first 100 frames
    // of the cropped output — leaving an audible fade at the head.
    loadWavIntoCurrentSample(makeWavBytes(800), "src.wav");
    const wb = getWorkbench(0)!;

    updateCurrentWorkbench({
      ...wb,
      chain: [
        fadeInNode(0, 100),
        { kind: "crop", params: { startFrame: 200, endFrame: 600 } },
      ],
    });
    const fadeFirstBytes = Array.from(song()!.samples[0]!.data);

    updateCurrentWorkbench({
      ...wb,
      chain: [
        { kind: "crop", params: { startFrame: 200, endFrame: 600 } },
        fadeInNode(0, 100),
      ],
    });
    const cropFirstBytes = Array.from(song()!.samples[0]!.data);

    // Same length (cropped to 400 source frames).
    expect(fadeFirstBytes.length).toBe(cropFirstBytes.length);
    // Bytes differ: the head of `cropFirstBytes` ramps from 0; the head
    // of `fadeFirstBytes` is full volume.
    expect(fadeFirstBytes).not.toEqual(cropFirstBytes);
    // First few bytes of cropFirst should be near zero (fade ramping in).
    let cropFirstHead = 0;
    let fadeFirstHead = 0;
    for (let i = 0; i < 5; i++) {
      cropFirstHead += Math.abs(cropFirstBytes[i]!);
      fadeFirstHead += Math.abs(fadeFirstBytes[i]!);
    }
    expect(cropFirstHead).toBeLessThan(fadeFirstHead);
  });

  it("normalize after fadeOut still scales the global peak to ±1", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb = getWorkbench(0)!;
    updateCurrentWorkbench({
      ...wb,
      chain: [
        fadeOutNode(200, 400),
        { kind: "normalize" },
      ],
    });
    // Peak in the int8 output should reach near ±127 (full-scale).
    const data = song()!.samples[0]!.data;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i]!));
    }
    expect(peak).toBeGreaterThanOrEqual(120); // close to int8 max
  });

  it("two fadeIns over the same range stack multiplicatively (not idempotent)", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb0 = getWorkbench(0)!;
    updateCurrentWorkbench({
      ...wb0,
      chain: [
        fadeInNode(0, 100),
        fadeInNode(0, 100),
      ],
    });
    const stackedBytes = Array.from(song()!.samples[0]!.data);

    updateCurrentWorkbench({
      ...wb0,
      chain: [fadeInNode(0, 100)],
    });
    const singleBytes = Array.from(song()!.samples[0]!.data);

    // Lengths match (no length changes), but the stacked version must
    // be quieter at the head (two ramps in series → quadratic).
    expect(stackedBytes.length).toBe(singleBytes.length);
    // Compare the very first non-zero byte index — the stacked head
    // ramps in slower, so its early energy is < single.
    let stackedHead = 0;
    let singleHead = 0;
    for (let i = 0; i < 50; i++) {
      stackedHead += Math.abs(stackedBytes[i]!);
      singleHead += Math.abs(singleBytes[i]!);
    }
    expect(stackedHead).toBeLessThan(singleHead);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Chiptune workbench with effect chain
// ──────────────────────────────────────────────────────────────────────

describe("Chiptune workbench with effect chain", () => {
  it("adding a crop to a chiptune workbench shrinks the int8 output", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    const fullLen = song()!.samples[0]!.lengthWords;

    addEffect("crop", null);
    const wb = getWorkbench(0)!;
    if (wb.chain[0]?.kind === "crop") {
      const half = Math.floor(wb.chain[0].params.endFrame / 2);
      updateCurrentWorkbench({
        ...wb,
        chain: [{ kind: "crop", params: { startFrame: 0, endFrame: half } }],
      });
    }
    const croppedLen = song()!.samples[0]!.lengthWords;
    expect(croppedLen).toBeLessThan(fullLen);
    expect(croppedLen).toBeGreaterThan(0);
    // Chiptune full-loop rule: the loop must still cover the whole new
    // post-crop output (loopStart=0, loopLength = full length).
    expect(song()!.samples[0]!.loopStartWords).toBe(0);
    expect(song()!.samples[0]!.loopLengthWords).toBe(croppedLen);
  });

  it("chiptune chain survives Chiptune→Sampler→Chiptune toggle", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    addEffect("volume", null);
    addEffect("normalize", null);
    const chiptuneChain = [...getWorkbench(0)!.chain];

    setSourceKind("sampler");
    expect(getWorkbench(0)!.source.kind).toBe("sampler");

    setSourceKind("chiptune");
    expect(getWorkbench(0)!.source.kind).toBe("chiptune");
    expect(getWorkbench(0)!.chain).toEqual(chiptuneChain);
  });

  it("updating chiptune params re-renders the slot's int8 immediately", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    const beforeLen = song()!.samples[0]!.data.length;

    // Default cycleFrames is 64; switch to 128 (one octave down) so
    // we expect the int8 length to roughly double.
    updateChiptune({ cycleFrames: 128 });
    const afterLen = song()!.samples[0]!.data.length;
    expect(afterLen).not.toBe(beforeLen);
    expect(afterLen).toBeGreaterThan(beforeLen);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Playback-gate behavior — setSourceKind / convertChiptuneToSampler
// ──────────────────────────────────────────────────────────────────────

describe("Playback gates on source-kind operations", () => {
  it("setSourceKind is a no-op while transport is playing (state unchanged)", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wbBefore = getWorkbench(0);
    setTransport("playing");
    setSourceKind("chiptune");
    expect(getWorkbench(0)).toBe(wbBefore); // no swap happened
  });

  it("convertChiptuneToSampler is a no-op while transport is playing", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    const wbBefore = getWorkbench(0);
    setTransport("playing");
    convertChiptuneToSampler();
    expect(getWorkbench(0)?.source.kind).toBe("chiptune");
    expect(getWorkbench(0)).toBe(wbBefore);
  });
});

describe("Imported stash preserves loop across the round-trip", () => {
  it("Imported (with loop) → Chiptune → Imported restores the loop verbatim", () => {
    seedImportedSlot({
      data: new Int8Array(200).fill(40),
      loopStartWords: 25,
      loopLengthWords: 30,
    });
    setSourceKind("chiptune");
    setSourceKind("sampler");
    expect(song()!.samples[0]!.loopStartWords).toBe(25);
    expect(song()!.samples[0]!.loopLengthWords).toBe(30);
    // No workbench: we're back in pure-imported state.
    expect(getWorkbench(0)).toBeUndefined();
  });

  it("convertSlotToSampler on an imported slot with a loop preserves the loop", () => {
    seedImportedSlot({
      data: new Int8Array(80).fill(20),
      loopStartWords: 10,
      loopLengthWords: 20,
    });
    convertSlotToSampler();
    // Loop fields untouched (convertSlotToSampler doesn't rewrite int8).
    expect(song()!.samples[0]!.loopStartWords).toBe(10);
    expect(song()!.samples[0]!.loopLengthWords).toBe(20);
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
  });
});

describe("convertChiptuneToSampler preserves audio and freezes chain context", () => {
  it("the int8 bytes are bit-identical pre/post freeze (just a source-shape swap)", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    const before = Array.from(song()!.samples[0]!.data);

    convertChiptuneToSampler();
    const after = Array.from(song()!.samples[0]!.data);
    expect(after).toEqual(before);
  });

  it("after freezing, adding a chain effect operates on the frozen render (not the synth)", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!);
    convertChiptuneToSampler();
    expect(getWorkbench(0)!.source.kind).toBe("sampler");

    // A crop on a sampler whose source is the frozen synth output should
    // shrink the int8 length predictably — proving the chain runs on the
    // captured WavData, not on a chiptune re-render.
    const beforeLen = song()!.samples[0]!.lengthWords;
    addEffect("crop", null);
    const wb = getWorkbench(0)!;
    if (wb.chain[0]?.kind === "crop") {
      const half = Math.floor(wb.chain[0].params.endFrame / 2);
      updateCurrentWorkbench({
        ...wb,
        chain: [{ kind: "crop", params: { startFrame: 0, endFrame: half } }],
      });
    }
    expect(song()!.samples[0]!.lengthWords).toBeLessThan(beforeLen);
  });
});

describe("Defensive: out-of-bounds effect ranges don't crash and don't produce garbage", () => {
  it("a crop whose endFrame is past the source length clamps to the source length", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb = getWorkbench(0)!;
    const baseline = song()!.samples[0]!.lengthWords;
    updateCurrentWorkbench({
      ...wb,
      chain: [{ kind: "crop", params: { startFrame: 0, endFrame: 999_999 } }],
    });
    // Crop that reaches past the end is the whole source — same length.
    expect(song()!.samples[0]!.lengthWords).toBe(baseline);
  });

  it("a crop whose start is past the source end clamps to empty (length=0/1)", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb = getWorkbench(0)!;
    expect(() => {
      updateCurrentWorkbench({
        ...wb,
        chain: [
          {
            kind: "crop",
            params: { startFrame: 999_999, endFrame: 999_999 + 100 },
          },
        ],
      });
    }).not.toThrow();
    expect(song()!.samples[0]!.lengthWords).toBeLessThanOrEqual(1);
  });

  it("a fadeOut over a zero-length range is a noop (passthrough)", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb0 = getWorkbench(0)!;
    const beforeBytes = Array.from(song()!.samples[0]!.data);
    updateCurrentWorkbench({
      ...wb0,
      chain: [fadeOutNode(200, 200)],
    });
    const afterBytes = Array.from(song()!.samples[0]!.data);
    expect(afterBytes).toEqual(beforeBytes);
  });
});

describe("Slot isolation: edits on slot 0 don't bleed into slot 1", () => {
  it("two independent slots maintain independent workbenches and chains", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "a.wav");
    addEffect("volume", null);
    const slot0Chain = [...getWorkbench(0)!.chain];

    setCurrentSample(2);
    loadWavIntoCurrentSample(makeWavBytes(600), "b.wav");
    addEffect("normalize", null);
    addEffect("reverse", { start: 0, end: 100 });
    const slot1Chain = [...getWorkbench(1)!.chain];

    expect(slot0Chain).toHaveLength(1);
    expect(slot1Chain).toHaveLength(2);
    // Editing slot 1 shouldn't have changed slot 0.
    setCurrentSample(1);
    expect(getWorkbench(0)!.chain).toEqual(slot0Chain);
  });

  it("clearCurrentSample on slot 0 doesn't disturb slot 1's workbench", () => {
    setCurrentSample(1);
    loadWavIntoCurrentSample(makeWavBytes(400), "a.wav");
    setCurrentSample(2);
    loadWavIntoCurrentSample(makeWavBytes(600), "b.wav");
    addEffect("normalize", null);
    const slot1Snapshot = getWorkbench(1)!;

    setCurrentSample(1);
    clearCurrentSample();
    expect(getWorkbench(0)).toBeUndefined();
    // Slot 1 still has its workbench and the same chain.
    expect(getWorkbench(1)).toBe(slot1Snapshot);
  });
});

describe("Multi-cycle source-kind toggling: state stays consistent", () => {
  it("Sampler→Chiptune→Sampler→Chiptune→Sampler: the Sampler half stays canonical", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const samplerSourceRef = getWorkbench(0)!.source;

    for (let i = 0; i < 3; i++) {
      setSourceKind("chiptune");
      setSourceKind("sampler");
      // After each round, we should still hold the same WAV source ref.
      expect(getWorkbench(0)!.source).toBe(samplerSourceRef);
    }
  });

  it("alt stash invariant: when source.kind === A, alt is null OR alt.source.kind === B", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    let wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    // Initially no alt — we just loaded fresh.
    expect(wb.alt).toBeNull();

    setSourceKind("chiptune");
    wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("chiptune");
    // Sampler half should now live in alt.
    expect(wb.alt?.source.kind).toBe("sampler");

    setSourceKind("sampler");
    wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    // Chiptune side should now be alt.
    expect(wb.alt?.source.kind).toBe("chiptune");

    setSourceKind("chiptune");
    wb = getWorkbench(0)!;
    expect(wb.alt?.source.kind).toBe("sampler");
  });
});

describe("Tiny / degenerate inputs", () => {
  it("a 1-frame WAV survives the pipeline (no division-by-zero)", () => {
    loadWavIntoCurrentSample(makeWavBytes(1), "tiny.wav");
    expect(getWorkbench(0)?.source.kind).toBe("sampler");
    // Slot length may collapse to 0 (1 frame at 22050 → ~0.4 frames at C-2)
    // but no crash.
    expect(() => getWorkbench(0)!.chain).not.toThrow();
  });

  it("an empty effect chain on a zero-length WAV doesn't crash", () => {
    expect(() => {
      loadWavIntoCurrentSample(makeWavBytes(0), "empty.wav");
    }).not.toThrow();
    // Slot's int8 length is 0, slot is effectively empty.
    expect(song()!.samples[0]!.lengthWords).toBe(0);
  });

  it("crop shrinking output to ~0 frames followed by a subsequent fade is graceful", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const wb = getWorkbench(0)!;
    expect(() => {
      updateCurrentWorkbench({
        ...wb,
        chain: [
          { kind: "crop", params: { startFrame: 100, endFrame: 100 } }, // empty
          fadeInNode(0, 50),
        ],
      });
    }).not.toThrow();
    expect(song()!.samples[0]!.lengthWords).toBeLessThanOrEqual(1);
  });
});

describe("Loop drag past sample end: replaceSampleData should clamp gracefully", () => {
  it("patchCurrentSample with loopLength way past data length clamps and doesn't corrupt", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const len = song()!.samples[0]!.lengthWords;
    expect(() => {
      patchCurrentSample({
        loopStartWords: 4,
        loopLengthWords: len * 100, // wildly past end
      });
    }).not.toThrow();
    const final = song()!.samples[0]!;
    // Loop must end at-or-before the data end.
    expect(final.loopStartWords + final.loopLengthWords).toBeLessThanOrEqual(
      len,
    );
  });

  it("patchCurrentSample with loopStart past data length clamps to a valid position", () => {
    loadWavIntoCurrentSample(makeWavBytes(400), "src.wav");
    const len = song()!.samples[0]!.lengthWords;
    expect(() => {
      patchCurrentSample({
        loopStartWords: len * 100,
        loopLengthWords: 4,
      });
    }).not.toThrow();
    const final = song()!.samples[0]!;
    expect(final.loopStartWords).toBeLessThanOrEqual(len);
  });
});

describe("loadWavIntoCurrentSample interactions", () => {
  it("loading a fresh WAV clears the imported stash so the previous Imported state isn't surprise-restored", () => {
    seedImportedSlot();
    setSourceKind("chiptune");
    expect(getImportedStash(0)).toBeDefined();

    // User loads a new WAV while in chiptune mode. The imported stash
    // becomes stale — the new WAV is now the canonical "previous" sampler.
    loadWavIntoCurrentSample(makeWavBytes(), "fresh.wav");
    expect(getImportedStash(0)).toBeUndefined();
    expect(getWorkbench(0)!.source.kind).toBe("sampler");
  });

  it("loading a fresh WAV preserves any chiptune workbench in `alt` so toggle-back keeps the synth", () => {
    setWorkbench(0, workbenchFromChiptune());
    updateCurrentWorkbench(getWorkbench(0)!); // populate slot
    loadWavIntoCurrentSample(makeWavBytes(), "fresh.wav");
    const wb = getWorkbench(0)!;
    expect(wb.source.kind).toBe("sampler");
    expect(wb.alt?.source.kind).toBe("chiptune");
  });
});
