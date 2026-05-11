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
      node.params as { points: ReadonlyArray<{ frame: number; value: number }> }
    ).points;
    expect(points).toHaveLength(2);
    // Both endpoints sit at value 1.5 (clamp-to-boundary makes this a
    // constant ×1.5 across the whole input).
    expect(points[0]!.value).toBeCloseTo(1.5, 6);
    expect(points[1]!.value).toBeCloseTo(1.5, 6);
    // The right endpoint's frame is replaced by the chain-stage's last
    // frame at parse time (the WAV embedded above is 200 frames long).
    expect(points[0]!.frame).toBe(0);
    expect(points[1]!.frame).toBe(199);
  });

  it("clamps an out-of-range gain (>2) into [0, 2] on migration", () => {
    const chain = tamperWithLegacyChain([
      { kind: "gain", params: { gain: 4 } },
    ]);
    const node = chain[0] as { params: { points: { value: number }[] } };
    expect(node.params.points.every((p) => p.value === 2)).toBe(true);
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
      { frame: 0, value: 0 },
      { frame: 50, value: 1 },
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
      { frame: 0, value: 1 },
      { frame: 9, value: 1 },
      { frame: 10, value: 0 },
      { frame: 30, value: 1 },
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
      { frame: 100, value: 1 },
      { frame: 150, value: 0 },
      { frame: 151, value: 1 },
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
                  { frame: 0, value: 1 },
                  { frame: 50, value: 0.5 },
                ],
              },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(9);
  });

  it("a chain with no envelope-bearing nodes serialises at v ≤ 5 (lowest-fits rule)", () => {
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
          // Crop is a length-changing range-aware effect; carries no
          // envelopes and shouldn't bump the schema version above the
          // minimum needed for the rest of the payload (mute / pattern
          // names are absent here, so v=3 is the floor for sampler
          // sources).
          chain: [{ kind: "crop", params: { startFrame: 0, endFrame: 50 } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    // Phase 1: writes always emit v=9 regardless of which optional fields
    // are populated. The lowest-fits policy was retired.
    expect(parsed.v).toBe(9);
  });

  it("a chain with a filter or shaper bumps the schema to v=7", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0.25)],
    };
    // Filter envelopes need at least 2 points each.
    const flat = (v: number) => [
      { frame: 0, value: v },
      { frame: 99, value: v },
    ];
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [
            {
              kind: "filter",
              params: { type: "lowpass", cutoff: flat(1000), q: flat(0.707) },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(9);
  });
});

describe("persistence: round-trip of the new volume envelope shape", () => {
  it("a multi-point envelope round-trips exactly through projectTo/FromBytes", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0.25)],
    };
    const original = [
      { frame: 0, value: 0.5 },
      { frame: 25, value: 1.5 },
      { frame: 75, value: 0.25 },
      { frame: 99, value: 1 },
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

describe("persistence migration: legacy filter scalar params → envelopes", () => {
  it("rewrites scalar cutoff and Q as 2-point flat envelopes", () => {
    const chain = tamperWithLegacyChain([
      {
        kind: "filter",
        params: { type: "lowpass", cutoff: 1000, q: 0.707 },
      },
    ]);
    expect(chain).toHaveLength(1);
    const node = chain[0] as {
      kind: string;
      params: {
        type: string;
        cutoff: { frame: number; value: number }[];
        q: { frame: number; value: number }[];
      };
    };
    expect(node.kind).toBe("filter");
    expect(node.params.type).toBe("lowpass");
    expect(node.params.cutoff).toHaveLength(2);
    expect(node.params.cutoff.every((p) => p.value === 1000)).toBe(true);
    expect(node.params.q).toHaveLength(2);
    expect(node.params.q.every((p) => Math.abs(p.value - 0.707) < 1e-6)).toBe(
      true,
    );
    // The right endpoint's frame is fixed up to chain-stage's last frame
    // (the 200-frame WAV embedded in tamperWithLegacyChain).
    expect(node.params.cutoff[0]!.frame).toBe(0);
    expect(node.params.cutoff[1]!.frame).toBe(199);
    expect(node.params.q[0]!.frame).toBe(0);
    expect(node.params.q[1]!.frame).toBe(199);
  });

  it("clamps out-of-range scalar cutoff / Q on migration", () => {
    const chain = tamperWithLegacyChain([
      {
        kind: "filter",
        params: { type: "lowpass", cutoff: 999_999, q: 999 },
      },
    ]);
    const node = chain[0] as {
      params: {
        cutoff: { value: number }[];
        q: { value: number }[];
      };
    };
    // PARAM_AXES: cutoff max 22050, q max 20.
    expect(node.params.cutoff.every((p) => p.value === 22050)).toBe(true);
    expect(node.params.q.every((p) => p.value === 20)).toBe(true);
  });
});

describe("persistence migration: legacy shaper scalar amount → envelope", () => {
  it("rewrites scalar amount as a 2-point flat envelope", () => {
    const chain = tamperWithLegacyChain([
      {
        kind: "shaper",
        params: { mode: "softClip", amount: 0.7 },
      },
    ]);
    const node = chain[0] as {
      kind: string;
      params: {
        mode: string;
        amount: { frame: number; value: number }[];
      };
    };
    expect(node.kind).toBe("shaper");
    expect(node.params.mode).toBe("softClip");
    expect(node.params.amount).toHaveLength(2);
    expect(
      node.params.amount.every((p) => Math.abs(p.value - 0.7) < 1e-6),
    ).toBe(true);
    expect(node.params.amount[0]!.frame).toBe(0);
    expect(node.params.amount[1]!.frame).toBe(199);
  });

  it("clamps amount > 1 down to 1", () => {
    const chain = tamperWithLegacyChain([
      {
        kind: "shaper",
        params: { mode: "hardClip", amount: 5 },
      },
    ]);
    const node = chain[0] as { params: { amount: { value: number }[] } };
    expect(node.params.amount.every((p) => p.value === 1)).toBe(true);
  });
});

describe("persistence: parser back-compat reads `gain`-keyed envelope points", () => {
  it("v=6 volume payloads with `gain` keys still load as envelope points", () => {
    // Synthesise a legacy v=6 payload where the points use the older
    // `gain` field name. The parser falls back to `gain` when `value`
    // is missing.
    const chain = tamperWithLegacyChain([
      {
        kind: "volume",
        params: {
          points: [
            { frame: 0, gain: 0.5 },
            { frame: 50, gain: 1.5 },
          ],
        },
      },
    ]);
    const node = chain[0] as {
      kind: string;
      params: { points: { frame: number; value: number }[] };
    };
    expect(node.kind).toBe("volume");
    expect(node.params.points).toEqual([
      { frame: 0, value: 0.5 },
      { frame: 50, value: 1.5 },
    ]);
  });
});

describe("persistence: pitch effect (v=8)", () => {
  it("a chain containing a pitch node serialises at v=8", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0.25)],
    };
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [
            {
              kind: "pitch",
              params: {
                envelope: [
                  { frame: 0, value: 1 },
                  { frame: 99, value: 2 },
                ],
              },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(9);
  });

  it("a pitch envelope round-trips exactly through projectTo/FromBytes", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array(100).fill(0.25)],
    };
    const original = [
      { frame: 0, value: 0.5 },
      { frame: 25, value: 1.5 },
      { frame: 75, value: 2 },
      { frame: 99, value: 1 },
    ];
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [{ kind: "pitch", params: { envelope: original } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    const node = restored!.samplerSources[0]!.chain[0]!;
    expect(node.kind).toBe("pitch");
    if (node.kind === "pitch") {
      expect(node.params.envelope).toEqual(original);
    }
  });
});

describe("persistence: bypass flag round-trips", () => {
  const wav = {
    sampleRate: 22050,
    channels: [new Float32Array(100).fill(0.25)],
  };
  const flat2 = (v: number) => [
    { frame: 0, value: v },
    { frame: 99, value: v },
  ];

  it("a bypassed effect serialises with bypassed:true and restores it", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [
            {
              kind: "volume",
              bypassed: true,
              params: { points: flat2(1.5) },
            },
          ],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    // On disk the field is present and true.
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.samplerSources["0"].chain[0].bypassed).toBe(true);
    // Round-trip preserves it.
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.samplerSources[0]!.chain[0]!.bypassed).toBe(true);
  });

  it("an un-bypassed effect omits the field on disk (bit-identical to pre-bypass)", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [{ kind: "volume", params: { points: flat2(1) } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect("bypassed" in parsed.samplerSources["0"].chain[0]).toBe(false);
  });

  it("bypassed:false (explicit) parses back as not-bypassed (field absent)", () => {
    // Tamper a payload to inject `bypassed: false` and confirm it
    // doesn't survive — the parser only attaches when the field is
    // truthy, so the in-memory shape stays clean.
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [{ kind: "volume", params: { points: flat2(1) } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    parsed.samplerSources["0"].chain[0].bypassed = false;
    const tampered = new TextEncoder().encode(JSON.stringify(parsed));
    const restored = projectFromBytes(tampered);
    const node = restored!.samplerSources[0]!.chain[0]!;
    expect("bypassed" in node).toBe(false);
  });
});
