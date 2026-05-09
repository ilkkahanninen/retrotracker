/**
 * Persistence: legacy gain / fadeIn / fadeOut effects auto-migrate to
 * `volume` envelopes on load.
 *
 * Strategy: tamper with a serialised `.retro` payload to inject the
 * old-shape effect nodes (we can't construct them via the typed
 * `projectToBytes` API anymore — the type union no longer includes the
 * legacy kinds), then re-parse and assert the migrated chain shape.
 *
 * Each migration is best-effort — the new clamp-to-boundary envelope
 * semantic doesn't have an exact representation of the old fadeIn /
 * fadeOut "outside the range = pass-through" rule without a 1-frame
 * artificial drop. That's documented in the parser; the tests here just
 * verify the documented shapes.
 */

import { describe, expect, it } from "vitest";
import { projectToBytes, projectFromBytes } from "../src/state/persistence";
import { writeWav } from "../src/core/audio/wav";
import { emptySong } from "../src/core/mod/format";
import { INITIAL_CURSOR } from "../src/state/cursor";

const baseInputs = () => ({
  song: emptySong(),
  filename: null,
  infoText: "",
  view: "sample" as const,
  cursor: { ...INITIAL_CURSOR },
  currentSample: 1,
  currentOctave: 2,
  editStep: 1,
});

/** A reasonably-sized WAV buffer to embed in the persistence payload —
 *  needs enough frames that the gain → volume sentinel-frame fixup has
 *  something useful to land on. */
function makeWavBytes(): Uint8Array {
  return writeWav(
    {
      sampleRate: 22050,
      channels: [new Float32Array(200).fill(0.5)],
    },
    { bitsPerSample: 16 },
  );
}

/** Build a `.retro` payload, parse the JSON, swap in the supplied legacy
 *  chain, re-serialise, and run it through `projectFromBytes`. Returns
 *  the migrated chain. */
function tamperWithLegacyChain(
  legacyChain: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const wav = {
    sampleRate: 22050,
    channels: [new Float32Array(200).fill(0.5)],
  };
  // Build a payload with a single empty-chain sampler source (typed),
  // then replace the chain in the JSON with the tampered legacy nodes.
  const bytes = projectToBytes({
    ...baseInputs(),
    samplerSources: {
      0: {
        sourceName: "test",
        wav,
        chain: [],
        pt: { monoMix: "average", targetNote: 12 },
      },
    },
  });
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text);
  parsed.samplerSources["0"].chain = legacyChain;
  // Pretend we're reading an older-version file.
  parsed.v = 5;
  const tampered = new TextEncoder().encode(JSON.stringify(parsed));
  const restored = projectFromBytes(tampered);
  expect(restored).not.toBeNull();
  return restored!.samplerSources[0]!.chain;
}

describe("persistence migration: legacy gain → volume envelope", () => {
  it("rewrites a single gain node as a 2-point flat envelope at the same gain", () => {
    const chain = tamperWithLegacyChain([
      { kind: "gain", params: { gain: 1.5 } },
    ]);
    expect(chain).toHaveLength(1);
    const node = chain[0] as { kind: string; params: unknown };
    expect(node.kind).toBe("volume");
    const points = (
      node.params as { points: ReadonlyArray<{ frame: number; gain: number }> }
    ).points;
    expect(points).toHaveLength(2);
    // Both endpoints sit at gain 1.5 (clamp-to-boundary makes this a
    // constant ×1.5 across the whole input).
    expect(points[0]!.gain).toBeCloseTo(1.5, 6);
    expect(points[1]!.gain).toBeCloseTo(1.5, 6);
    // The right endpoint's frame is replaced by the chain-stage's last
    // frame at parse time (the WAV embedded above is 200 frames long).
    expect(points[0]!.frame).toBe(0);
    expect(points[1]!.frame).toBe(199);
  });

  it("clamps an out-of-range gain (>2) into [0, 2] on migration", () => {
    const chain = tamperWithLegacyChain([
      { kind: "gain", params: { gain: 4 } },
    ]);
    const node = chain[0] as { params: { points: { gain: number }[] } };
    expect(node.params.points.every((p) => p.gain === 2)).toBe(true);
  });
});

describe("persistence migration: legacy fadeIn → volume envelope", () => {
  it("fadeIn starting at frame 0 emits 2 points (0,0) → (e,1)", () => {
    const chain = tamperWithLegacyChain([
      { kind: "fadeIn", params: { startFrame: 0, endFrame: 50 } },
    ]);
    const node = chain[0] as { kind: string; params: unknown };
    expect(node.kind).toBe("volume");
    const points = (
      node.params as { points: { frame: number; gain: number }[] }
    ).points;
    expect(points).toEqual([
      { frame: 0, gain: 0 },
      { frame: 50, gain: 1 },
    ]);
  });

  it("fadeIn starting mid-sample emits 4 points (0,1) → (s-1,1) → (s,0) → (e,1)", () => {
    const chain = tamperWithLegacyChain([
      { kind: "fadeIn", params: { startFrame: 10, endFrame: 30 } },
    ]);
    const node = chain[0] as {
      params: { points: { frame: number; gain: number }[] };
    };
    expect(node.params.points).toEqual([
      { frame: 0, gain: 1 },
      { frame: 9, gain: 1 },
      { frame: 10, gain: 0 },
      { frame: 30, gain: 1 },
    ]);
  });
});

describe("persistence migration: legacy fadeOut → volume envelope", () => {
  it("emits 3 points (s,1) → (e,0) → (e+1,1) so gain returns to 1 after the ramp", () => {
    const chain = tamperWithLegacyChain([
      { kind: "fadeOut", params: { startFrame: 100, endFrame: 150 } },
    ]);
    const node = chain[0] as {
      params: { points: { frame: number; gain: number }[] };
    };
    expect(node.params.points).toEqual([
      { frame: 100, gain: 1 },
      { frame: 150, gain: 0 },
      { frame: 151, gain: 1 },
    ]);
  });
});

describe("persistence migration: chain mixing legacy + new effects", () => {
  it("preserves order and migrates only the legacy entries", () => {
    const chain = tamperWithLegacyChain([
      { kind: "gain", params: { gain: 0.5 } },
      { kind: "normalize" },
      { kind: "fadeIn", params: { startFrame: 0, endFrame: 10 } },
      { kind: "filter", params: { type: "lowpass", cutoff: 4000, q: 0.707 } },
    ]);
    expect(chain).toHaveLength(4);
    expect((chain[0] as { kind: string }).kind).toBe("volume");
    expect((chain[1] as { kind: string }).kind).toBe("normalize");
    expect((chain[2] as { kind: string }).kind).toBe("volume");
    expect((chain[3] as { kind: string }).kind).toBe("filter");
  });
});

describe("persistence: v=6 is written when any chain has a volume envelope", () => {
  it("a chain with a volume node serialises with v=6", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0)],
    };
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [
            {
              kind: "volume",
              params: {
                points: [
                  { frame: 0, gain: 1 },
                  { frame: 50, gain: 0.5 },
                ],
              },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(6);
  });

  it("a chain with no volume node serialises at v ≤ 5 (lowest-fits rule)", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0)],
    };
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [
            {
              kind: "filter",
              params: { type: "lowpass", cutoff: 1000, q: 0.7 },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBeLessThanOrEqual(5);
  });
});

describe("persistence: round-trip of the new volume envelope shape", () => {
  it("a multi-point envelope round-trips exactly through projectTo/FromBytes", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0.25)],
    };
    const original = [
      { frame: 0, gain: 0.5 },
      { frame: 25, gain: 1.5 },
      { frame: 75, gain: 0.25 },
      { frame: 99, gain: 1 },
    ];
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [{ kind: "volume", params: { points: original } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    const node = restored!.samplerSources[0]!.chain[0]!;
    expect(node.kind).toBe("volume");
    if (node.kind === "volume") {
      expect(node.params.points).toEqual(original);
    }
  });
});
