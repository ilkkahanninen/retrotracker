import { describe, expect, it } from "vitest";
import { projectToBytes, projectFromBytes } from "../src/state/persistence";
import { defaultChiptuneParams } from "../src/core/audio/chiptune";
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

describe("persistence: chiptune source round-trip", () => {
  it("persists chiptune params per slot through projectToBytes / projectFromBytes", () => {
    // Pick a cycleFrames that's already on the musical (octave-aligned)
    // grid so the round-trip is bit-identical — `chiptuneFromJson` snaps
    // off-grid values, which is the right behaviour but would muddle this
    // assertion.
    const params = {
      ...defaultChiptuneParams(),
      cycleFrames: 128,
      amplitude: 0.7,
      osc1: { shapeIndex: 1.5, phaseSplit: 0.3, ratio: 2 },
      osc2: { shapeIndex: 2.75, phaseSplit: 0.6, ratio: 1 },
      combineMode: "fm" as const,
      combineAmount: 0.4,
    };
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: params, 5: defaultChiptuneParams() },
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({
      0: params,
      5: defaultChiptuneParams(),
    });
  });

  it("omits chiptuneSources when the map is empty (back-compat with v=1 readers)", () => {
    const bytes = projectToBytes(baseInputs());
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(parsed.chiptuneSources).toBeUndefined();
  });

  it("persists per-channel mute / solo state through projectToBytes / projectFromBytes", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      mutedChannels: [false, true, false, true],
      soloedChannels: [true, false, false, false],
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.mutedChannels).toEqual([false, true, false, true]);
    expect(restored!.soloedChannels).toEqual([true, false, false, false]);
  });

  it("writes v=5 when any channel is muted or solo'd", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      mutedChannels: [false, false, true, false],
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(5);
    expect(parsed.mutedChannels).toEqual([false, false, true, false]);
    // Soloed array still emitted (as all-false) so the loader sees both.
    expect(parsed.soloedChannels).toEqual([false, false, false, false]);
  });

  it("omits mute/solo arrays and stays at the lower version when all flags are false", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      mutedChannels: [false, false, false, false],
      soloedChannels: [false, false, false, false],
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.v).toBe(1);
    expect(parsed.mutedChannels).toBeUndefined();
    expect(parsed.soloedChannels).toBeUndefined();
  });

  it("loads mute/solo as all-false when the payload predates v=5", () => {
    // Build a v=1 payload by omitting the mute fields, then load it.
    const bytes = projectToBytes(baseInputs());
    const restored = projectFromBytes(bytes);
    expect(restored!.mutedChannels).toEqual([false, false, false, false]);
    expect(restored!.soloedChannels).toEqual([false, false, false, false]);
  });

  it("writes v=2 when chiptune slots are present", () => {
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: defaultChiptuneParams() },
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(2);
  });

  it("drops slot entries with corrupt params instead of failing the whole load", () => {
    // Hand-craft a payload with one valid + one corrupt slot.
    const bytes = projectToBytes({
      ...baseInputs(),
      chiptuneSources: { 0: defaultChiptuneParams() },
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    parsed.chiptuneSources["7"] = { combineMode: "bogus" };
    const tampered = new TextEncoder().encode(JSON.stringify(parsed));
    const restored = projectFromBytes(tampered);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({ 0: defaultChiptuneParams() });
  });

  it("returns an empty chiptuneSources record for v=1 payloads", () => {
    // A "v=1" payload — same shape as today's bytes when no chiptune slots
    // exist. The loader must still yield a (materialised) empty record.
    const bytes = projectToBytes(baseInputs());
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    expect(restored!.chiptuneSources).toEqual({});
  });
});

describe("persistence: sampler chain round-trip", () => {
  // Regression: the shaper effect (added later than gain/filter/crossfade)
  // wasn't covered in `parseEffectNode`, so it was silently dropped on reload.
  // Keep one assertion per effect kind so a future addition can't slip
  // through the parser the same way.
  it("round-trips every effect kind through the chain", () => {
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array([0, 0.5, -0.5, 0.25])],
    };
    const chain = [
      { kind: "gain", params: { gain: 1.5 } },
      { kind: "normalize" },
      { kind: "reverse", params: { startFrame: 0, endFrame: 4 } },
      { kind: "crop", params: { startFrame: 1, endFrame: 4 } },
      { kind: "cut", params: { startFrame: 0, endFrame: 1 } },
      { kind: "fadeIn", params: { startFrame: 0, endFrame: 2 } },
      { kind: "fadeOut", params: { startFrame: 2, endFrame: 4 } },
      {
        kind: "filter",
        params: { type: "lowpass" as const, cutoff: 4000, q: 0.707 },
      },
      { kind: "crossfade", params: { length: 16 } },
      { kind: "shaper", params: { mode: "softClip" as const, amount: 0.7 } },
    ] as const;
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [...chain] as never,
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    const restored = projectFromBytes(bytes);
    expect(restored).not.toBeNull();
    const restoredChain = restored!.samplerSources[0]!.chain;
    expect(restoredChain).toHaveLength(chain.length);
    for (let i = 0; i < chain.length; i++) {
      expect(restoredChain[i]!.kind).toBe(chain[i]!.kind);
    }
    // Spot-check the shaper params explicitly — the regression that motivated
    // this whole block.
    const shaper = restoredChain.find((n) => n.kind === "shaper");
    expect(shaper).toBeDefined();
    if (shaper && shaper.kind === "shaper") {
      expect(shaper.params.mode).toBe("softClip");
      expect(shaper.params.amount).toBeCloseTo(0.7, 6);
    }
  });

  it("drops a shaper node with an unknown mode rather than crashing the load", () => {
    const wav = { sampleRate: 22050, channels: [new Float32Array([0])] };
    const bytes = projectToBytes({
      ...baseInputs(),
      samplerSources: {
        0: {
          sourceName: "test",
          wav,
          chain: [{ kind: "gain", params: { gain: 1 } }],
          pt: { monoMix: "average", targetNote: 12 },
        },
      },
    });
    // Tamper: replace the gain with a shaper that has a bogus mode.
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    parsed.samplerSources["0"].chain = [
      { kind: "shaper", params: { mode: "bogus", amount: 0.5 } },
    ];
    const tampered = new TextEncoder().encode(JSON.stringify(parsed));
    const restored = projectFromBytes(tampered);
    expect(restored).not.toBeNull();
    // Bogus node parsed to null and was filtered out — chain ends up empty
    // rather than failing the whole project load.
    expect(restored!.samplerSources[0]!.chain).toEqual([]);
  });
});
