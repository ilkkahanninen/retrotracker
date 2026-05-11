/**
 * Volume envelope: state-action tests.
 *
 * Covers `addEnvelopePoint` / `removeEnvelopePoint` / `patchEnvelopePoint` /
 * `nudgeEnvelopeSegment` — the helpers `EnvelopeOverlay` calls in response
 * to user gestures. We drive the helpers directly (no UI mount) and read
 * the post-state from the workbench map.
 *
 * The overlay-rendering tests (DOM, dblclick, drag) live in
 * `tests/ui/sample-envelope-overlay.test.tsx`; pipeline math is in
 * `tests/sample-workbench.test.ts` ("applyVolumeEnvelope").
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addEnvelopePoint,
  loadWavIntoCurrentSample,
  patchEffect,
  patchEnvelopePoint,
  removeEnvelopePoint,
  nudgeEnvelopeSegment,
  setEffectBypass,
} from "../src/state/sampleEdit";
import { addEffect } from "../src/state/sampleEdit";
import { clearHistory, setSong, setTransport, pt2Song as song } from "../src/state/song";
import { setCurrentSample } from "../src/state/edit";
import {
  clearAllWorkbenches,
  getWorkbench,
} from "../src/state/sampleWorkbench";
import { clearAllStashedLoops } from "../src/state/loopStash";
import { clearAllImportedStashes } from "../src/state/importedStash";
import { emptySong } from "../src/core/mod/format";
import { writeWav } from "../src/core/audio/wav";
import {
  ENVELOPE_GAIN_MAX,
  ENVELOPE_MIN_POINTS,
} from "../src/core/audio/sampleWorkbench";

function reset(): void {
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

function makeWavBytes(frames = 800): Uint8Array {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((i / 32) * Math.PI) * 0.5;
  return writeWav({ sampleRate: 22050, channels: [ch] }, { bitsPerSample: 16 });
}

/** Set up a sampler workbench with a volume effect at chain[0]. Returns
 *  the points so the test can compare. */
function seedWithVolume(): ReturnType<
  NonNullable<ReturnType<typeof getWorkbench>>["chain"][0] extends {
    params: infer P;
  }
    ? () => P
    : never
> | null {
  loadWavIntoCurrentSample(makeWavBytes(), "tone.wav");
  addEffect("volume", null);
  return null;
}

describe("addEnvelopePoint", () => {
  it("inserts a new point and keeps the array sorted by frame", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 50, value: 0.5 });
    const wb = getWorkbench(0)!;
    const node = wb.chain[0]!;
    expect(node.kind).toBe("volume");
    if (node.kind !== "volume") return;
    const pts = node.params.points;
    // Default 2 endpoint points + the new mid-point.
    expect(pts.length).toBe(3);
    // Sorted ascending by frame.
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.frame).toBeGreaterThanOrEqual(pts[i - 1]!.frame);
    }
    expect(pts.find((p) => p.frame === 50)?.value).toBeCloseTo(0.5, 6);
  });

  it("clamps gain into [ENVELOPE_GAIN_MIN, ENVELOPE_GAIN_MAX]", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 50, value: 99 });
    addEnvelopePoint(0, "volume", { frame: 60, value: -99 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    expect(node.params.points.find((p) => p.frame === 50)!.value).toBe(
      ENVELOPE_GAIN_MAX,
    );
    expect(node.params.points.find((p) => p.frame === 60)!.value).toBe(0);
  });

  it("dedupes points landing on the same frame (last write wins)", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 100, value: 0.5 });
    addEnvelopePoint(0, "volume", { frame: 100, value: 1.5 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    const at100 = node.params.points.filter((p) => p.frame === 100);
    expect(at100.length).toBe(1);
    expect(at100[0]!.value).toBeCloseTo(1.5, 6);
  });

  it("is a no-op when the targeted chain entry is not a volume node", () => {
    loadWavIntoCurrentSample(makeWavBytes(), "tone.wav");
    addEffect("normalize", null);
    const before = getWorkbench(0)!.chain;
    addEnvelopePoint(0, "volume", { frame: 10, value: 0.5 });
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});

describe("removeEnvelopePoint", () => {
  it("removes the targeted point", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 50, value: 0.5 });
    addEnvelopePoint(0, "volume", { frame: 100, value: 1.5 });
    const wb1 = getWorkbench(0)!;
    const node1 = wb1.chain[0]!;
    if (node1.kind !== "volume") throw new Error("expected volume node");
    expect(node1.params.points.length).toBe(4);

    // Find the index of the frame-50 point and remove it.
    const idx = node1.params.points.findIndex((p) => p.frame === 50);
    removeEnvelopePoint(0, "volume", idx);

    const node2 = getWorkbench(0)!.chain[0]!;
    if (node2.kind !== "volume") throw new Error("expected volume node");
    expect(node2.params.points.length).toBe(3);
    expect(node2.params.points.find((p) => p.frame === 50)).toBeUndefined();
  });

  it("refuses to drop below the 2-point minimum", () => {
    seedWithVolume();
    const wbBefore = getWorkbench(0)!;
    const node = wbBefore.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    expect(node.params.points.length).toBe(ENVELOPE_MIN_POINTS);

    removeEnvelopePoint(0, "volume", 0);
    removeEnvelopePoint(0, "volume", 1);

    const after = getWorkbench(0)!.chain[0]!;
    if (after.kind !== "volume") throw new Error("expected volume node");
    expect(after.params.points.length).toBe(ENVELOPE_MIN_POINTS);
  });

  it("ignores out-of-range indices", () => {
    seedWithVolume();
    const before = getWorkbench(0)!.chain;
    removeEnvelopePoint(0, "volume", -1);
    removeEnvelopePoint(0, "volume", 99);
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});

describe("patchEnvelopePoint", () => {
  it("updates a point's gain (frame untouched)", () => {
    seedWithVolume();
    patchEnvelopePoint(0, "volume", 0, { value: 1.5 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    expect(node.params.points[0]!.value).toBeCloseTo(1.5, 6);
  });

  it("clamps gain", () => {
    seedWithVolume();
    patchEnvelopePoint(0, "volume", 0, { value: 999 });
    patchEnvelopePoint(0, "volume", 1, { value: -5 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    expect(node.params.points[0]!.value).toBe(ENVELOPE_GAIN_MAX);
    expect(node.params.points[1]!.value).toBe(0);
  });

  it("normalises (sorts + dedupes) when a frame change crosses a neighbour", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 100, value: 0.5 });
    // Drag the rightmost (last) point to frame 50 — past the mid-point at
    // frame 100. After commit, the array should be re-sorted and the
    // landing-point should still be present.
    const before = getWorkbench(0)!.chain[0]!;
    if (before.kind !== "volume") throw new Error("expected volume node");
    const lastIdx = before.params.points.length - 1;
    patchEnvelopePoint(0, "volume", lastIdx, { frame: 50 });
    const after = getWorkbench(0)!.chain[0]!;
    if (after.kind !== "volume") throw new Error("expected volume node");
    for (let i = 1; i < after.params.points.length; i++) {
      expect(after.params.points[i]!.frame).toBeGreaterThanOrEqual(
        after.params.points[i - 1]!.frame,
      );
    }
  });
});

describe("nudgeEnvelopeSegment", () => {
  it("shifts both endpoints' gain by the same delta, frames untouched", () => {
    seedWithVolume();
    const before = getWorkbench(0)!.chain[0]!;
    if (before.kind !== "volume") throw new Error("expected volume node");
    const beforePts = before.params.points;
    const f0 = beforePts[0]!.frame;
    const f1 = beforePts[1]!.frame;
    const g0 = beforePts[0]!.value;
    const g1 = beforePts[1]!.value;

    nudgeEnvelopeSegment(0, "volume", 0, 0.3);

    const after = getWorkbench(0)!.chain[0]!;
    if (after.kind !== "volume") throw new Error("expected volume node");
    expect(after.params.points[0]!.frame).toBe(f0);
    expect(after.params.points[1]!.frame).toBe(f1);
    expect(after.params.points[0]!.value).toBeCloseTo(g0 + 0.3, 5);
    expect(after.params.points[1]!.value).toBeCloseTo(g1 + 0.3, 5);
  });

  it("clamps each endpoint's gain to [0, ENVELOPE_GAIN_MAX]", () => {
    seedWithVolume();
    nudgeEnvelopeSegment(0, "volume", 0, 999);
    const after = getWorkbench(0)!.chain[0]!;
    if (after.kind !== "volume") throw new Error("expected volume node");
    expect(after.params.points[0]!.value).toBe(ENVELOPE_GAIN_MAX);
    expect(after.params.points[1]!.value).toBe(ENVELOPE_GAIN_MAX);
  });

  it("ignores invalid leftPointIndex (last point or out-of-range)", () => {
    seedWithVolume();
    const before = getWorkbench(0)!.chain;
    nudgeEnvelopeSegment(0, "volume", -1, 0.5);
    nudgeEnvelopeSegment(0, "volume", 99, 0.5);
    // Pass the last index — there's no segment to its right.
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    nudgeEnvelopeSegment(0, "volume", node.params.points.length - 1, 0.5);
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});

describe("integration: chain mutation goes through commit (history snapshot)", () => {
  it("each envelope edit produces a fresh chain reference (so the workbench-map ref churns and undo can roll it back)", () => {
    seedWithVolume();
    const c0 = getWorkbench(0)!.chain;
    addEnvelopePoint(0, "volume", { frame: 10, value: 0.5 });
    const c1 = getWorkbench(0)!.chain;
    expect(c1).not.toBe(c0);

    patchEnvelopePoint(0, "volume", 0, { value: 1.2 });
    const c2 = getWorkbench(0)!.chain;
    expect(c2).not.toBe(c1);
  });

  it("envelope edits also work via patchEffect when wholesale-replacing the node", () => {
    // Sanity check the underlying surface: patchEffect with a brand-new
    // node body works the same as the granular helpers — we use this in
    // the editor when a drag finishes with a sort/dedupe.
    seedWithVolume();
    patchEffect(0, {
      kind: "volume",
      params: {
        points: [
          { frame: 0, value: 0.25 },
          { frame: 100, value: 1.75 },
        ],
      },
    });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "volume") throw new Error("expected volume node");
    expect(node.params.points).toEqual([
      { frame: 0, value: 0.25 },
      { frame: 100, value: 1.75 },
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Filter envelope: cutoff and Q are addressed independently.
// ──────────────────────────────────────────────────────────────────────

function seedWithFilter(): void {
  loadWavIntoCurrentSample(makeWavBytes(800), "tone.wav");
  addEffect("filter", null);
}

describe("filter envelope state actions", () => {
  it("addEnvelopePoint(idx, 'cutoff', ...) targets the cutoff envelope, not Q", () => {
    seedWithFilter();
    addEnvelopePoint(0, "cutoff", { frame: 100, value: 4000 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "filter") throw new Error("expected filter node");
    // Cutoff has 3 points, Q is unchanged at 2.
    expect(node.params.cutoff.length).toBe(3);
    expect(node.params.q.length).toBe(2);
    expect(node.params.cutoff.find((p) => p.frame === 100)?.value).toBeCloseTo(
      4000,
      1,
    );
  });

  it("addEnvelopePoint(idx, 'q', ...) targets the Q envelope, not cutoff", () => {
    seedWithFilter();
    addEnvelopePoint(0, "q", { frame: 200, value: 5 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "filter") throw new Error("expected filter node");
    expect(node.params.q.length).toBe(3);
    expect(node.params.cutoff.length).toBe(2);
    expect(node.params.q.find((p) => p.frame === 200)?.value).toBeCloseTo(5, 5);
  });

  it("clamps cutoff value to the cutoff axis range, q to the Q range", () => {
    seedWithFilter();
    // PARAM_AXES.cutoff: [10, 22050]; PARAM_AXES.q: [0.1, 20].
    addEnvelopePoint(0, "cutoff", { frame: 50, value: 99999 });
    addEnvelopePoint(0, "q", { frame: 50, value: 99999 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "filter") throw new Error("expected filter node");
    expect(node.params.cutoff.find((p) => p.frame === 50)!.value).toBe(22050);
    expect(node.params.q.find((p) => p.frame === 50)!.value).toBe(20);
  });

  it("removeEnvelopePoint refuses to drop the Q envelope below 2 points", () => {
    seedWithFilter();
    removeEnvelopePoint(0, "q", 0);
    removeEnvelopePoint(0, "q", 1);
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "filter") throw new Error("expected filter node");
    expect(node.params.q.length).toBe(2);
  });

  it("wrong (kind, param) combination is a no-op", () => {
    seedWithFilter();
    const before = getWorkbench(0)!.chain;
    // 'volume' isn't a filter param — silently ignored.
    addEnvelopePoint(0, "volume", { frame: 50, value: 0.5 });
    // 'amount' isn't a filter param either.
    addEnvelopePoint(0, "amount", { frame: 50, value: 0.5 });
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shaper envelope: amount only.
// ──────────────────────────────────────────────────────────────────────

function seedWithShaper(): void {
  loadWavIntoCurrentSample(makeWavBytes(800), "tone.wav");
  addEffect("shaper", null);
}

describe("shaper envelope state actions", () => {
  it("addEnvelopePoint(idx, 'amount', ...) appends to the amount envelope", () => {
    seedWithShaper();
    addEnvelopePoint(0, "amount", { frame: 100, value: 0.8 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "shaper") throw new Error("expected shaper node");
    expect(node.params.amount.length).toBe(3);
    expect(node.params.amount.find((p) => p.frame === 100)?.value).toBeCloseTo(
      0.8,
      6,
    );
  });

  it("clamps amount to [0, 1]", () => {
    seedWithShaper();
    addEnvelopePoint(0, "amount", { frame: 50, value: 99 });
    addEnvelopePoint(0, "amount", { frame: 60, value: -5 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "shaper") throw new Error("expected shaper node");
    expect(node.params.amount.find((p) => p.frame === 50)!.value).toBe(1);
    expect(node.params.amount.find((p) => p.frame === 60)!.value).toBe(0);
  });

  it("nudgeEnvelopeSegment shifts both endpoints' amount", () => {
    seedWithShaper();
    nudgeEnvelopeSegment(0, "amount", 0, 0.2);
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "shaper") throw new Error("expected shaper node");
    // Default flat envelope at 0.5 + 0.2 = 0.7 on both endpoints.
    expect(node.params.amount[0]!.value).toBeCloseTo(0.7, 5);
    expect(node.params.amount[1]!.value).toBeCloseTo(0.7, 5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pitch envelope: speed factor only.
// ──────────────────────────────────────────────────────────────────────

function seedWithPitch(): void {
  loadWavIntoCurrentSample(makeWavBytes(800), "tone.wav");
  addEffect("pitch", null);
}

describe("pitch envelope state actions", () => {
  it("addEnvelopePoint(idx, 'pitch', ...) appends to the pitch envelope", () => {
    seedWithPitch();
    addEnvelopePoint(0, "pitch", { frame: 100, value: 2 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "pitch") throw new Error("expected pitch node");
    expect(node.params.envelope.length).toBe(3);
    expect(
      node.params.envelope.find((p) => p.frame === 100)?.value,
    ).toBeCloseTo(2, 6);
  });

  it("clamps speed to [0.25, 4]", () => {
    seedWithPitch();
    addEnvelopePoint(0, "pitch", { frame: 50, value: 99 });
    addEnvelopePoint(0, "pitch", { frame: 60, value: 0.001 });
    const node = getWorkbench(0)!.chain[0]!;
    if (node.kind !== "pitch") throw new Error("expected pitch node");
    expect(node.params.envelope.find((p) => p.frame === 50)!.value).toBe(4);
    expect(node.params.envelope.find((p) => p.frame === 60)!.value).toBe(0.25);
  });

  it("changing the pitch envelope changes the slot's int8 length (output is variable)", () => {
    seedWithPitch();
    const baselineLen = song()!.samples[0]!.lengthWords;
    // Push the entire envelope to 2× — output should halve.
    patchEnvelopePoint(0, "pitch", 0, { value: 2 });
    patchEnvelopePoint(0, "pitch", 1, { value: 2 });
    const sped = song()!.samples[0]!.lengthWords;
    expect(sped).toBeLessThan(baselineLen);
    // ~half, allowing for word-alignment rounding.
    expect(sped * 2).toBeLessThanOrEqual(baselineLen + 2);
  });

  it("wrong (kind, param) combination is a no-op", () => {
    seedWithPitch();
    const before = getWorkbench(0)!.chain;
    addEnvelopePoint(0, "volume", { frame: 50, value: 1.5 });
    addEnvelopePoint(0, "cutoff", { frame: 50, value: 1000 });
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Bypass: per-effect on/off toggle that preserves params.
// ──────────────────────────────────────────────────────────────────────

describe("setEffectBypass", () => {
  it("setting bypassed=true marks the chain entry as bypassed", () => {
    seedWithVolume();
    setEffectBypass(0, true);
    const node = getWorkbench(0)!.chain[0]!;
    expect(node.bypassed).toBe(true);
  });

  it("setting bypassed=false strips the field entirely (clean serialisation)", () => {
    seedWithVolume();
    setEffectBypass(0, true);
    setEffectBypass(0, false);
    const node = getWorkbench(0)!.chain[0]!;
    expect("bypassed" in node).toBe(false);
  });

  it("bypass preserves the effect's params for easy A/B", () => {
    seedWithVolume();
    addEnvelopePoint(0, "volume", { frame: 50, value: 0.25 });
    const beforeBypass = getWorkbench(0)!.chain[0]!;
    if (beforeBypass.kind !== "volume") throw new Error("expected volume");
    const pointsBefore = beforeBypass.params.points;

    setEffectBypass(0, true);
    setEffectBypass(0, false);

    const after = getWorkbench(0)!.chain[0]!;
    if (after.kind !== "volume") throw new Error("expected volume");
    expect(after.params.points).toEqual(pointsBefore);
  });

  it("bypassing a length-changing effect (pitch) restores the original int8 length", () => {
    seedWithPitch();
    const baselineLen = song()!.samples[0]!.lengthWords;
    // 2× pitch halves the slot length.
    patchEnvelopePoint(0, "pitch", 0, { value: 2 });
    patchEnvelopePoint(0, "pitch", 1, { value: 2 });
    const sped = song()!.samples[0]!.lengthWords;
    expect(sped).toBeLessThan(baselineLen);
    // Bypass it — the pipeline re-runs and the slot length returns
    // to (approximately) baseline.
    setEffectBypass(0, true);
    const restored = song()!.samples[0]!.lengthWords;
    // Allow ±2 words for word-alignment / boundary effects elsewhere
    // in the chain.
    expect(Math.abs(restored - baselineLen)).toBeLessThanOrEqual(2);
  });

  it("ignores out-of-range chain indices", () => {
    seedWithVolume();
    const before = getWorkbench(0)!.chain;
    setEffectBypass(99, true);
    setEffectBypass(-1, true);
    expect(getWorkbench(0)!.chain).toEqual(before);
  });
});
