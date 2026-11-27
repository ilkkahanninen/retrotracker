import { describe, expect, it } from "vitest";

import { emptyXmPattern, emptyXmSong } from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";
import {
  projectFromBytes,
  projectToBytes,
  type SessionInputs,
} from "~/state/persistence";

/**
 * Pure round-trip tests for FT2 `.retro` persistence. Use the
 * Uint8Array-bytes path (`projectToBytes` / `projectFromBytes`) — this
 * file runs in node, where localStorage doesn't exist; saveSession /
 * loadSession would silently swallow on the writer side.
 */

const baseInputs = (overrides: Partial<SessionInputs> = {}): SessionInputs => ({
  song: emptyXmSong(),
  filename: "demo.xm",
  infoText: "",
  view: "pattern",
  cursor: { order: 0, row: 0, channel: 0, field: "note" },
  currentSample: 1,
  currentOctave: 2,
  editStep: 1,
  ...overrides,
});

describe("FT2 .retro persistence", () => {
  it("round-trips an XmSong through projectToBytes + projectFromBytes", () => {
    let song = emptyXmSong();
    song.title = "FT2 saved";
    song = setXmCell(song, 0, 5, 0, { note: 49, instrument: 1 });
    const bytes = projectToBytes(baseInputs({ song }));
    const loaded = projectFromBytes(bytes);
    expect(loaded).not.toBeNull();
    expect(loaded!.song.format).toBe("FT2");
    if (loaded!.song.format !== "FT2") throw new Error("expected FT2");
    expect(loaded!.song.title).toBe("FT2 saved");
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.note).toBe(49);
    expect(loaded!.song.patterns[0]!.rows[5]![0]!.instrument).toBe(1);
  });

  it("preserves channelCount through round-trip", () => {
    const song = { ...emptyXmSong(), channelCount: 16 };
    song.patterns = [
      {
        rows: Array.from({ length: 64 }, () =>
          Array.from({ length: 16 }, () => ({
            note: 0,
            instrument: 0,
            volumeColumn: 0,
            effect: 0,
            effectParam: 0,
          })),
        ),
        rowCount: 64,
      },
    ];
    const bytes = projectToBytes(baseInputs({ song }));
    const loaded = projectFromBytes(bytes);
    expect(loaded!.song.format).toBe("FT2");
    if (loaded!.song.format !== "FT2") throw new Error("expected FT2");
    expect(loaded!.song.channelCount).toBe(16);
  });

  it("filename / view / cursor / editStep are preserved", () => {
    const bytes = projectToBytes(
      baseInputs({
        filename: "saved.xm",
        view: "info",
        cursor: { order: 0, row: 12, channel: 2, field: "note" },
        editStep: 4,
      }),
    );
    const loaded = projectFromBytes(bytes)!;
    expect(loaded.filename).toBe("saved.xm");
    expect(loaded.view).toBe("info");
    expect(loaded.cursor).toEqual({
      order: 0,
      row: 12,
      channel: 2,
      field: "note",
    });
    expect(loaded.editStep).toBe(4);
  });

  it('payload carries format="FT2" so the reader picks parseXm', () => {
    const song = emptyXmSong();
    const bytes = projectToBytes(baseInputs({ song }));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    expect(json.format).toBe("FT2");
    expect(json.v).toBe(9);
  });

  it("round-trips an XM chiptune workbench so the source kind survives reload", async () => {
    const { defaultChiptuneParams } = await import("~/core/audio/chiptune");
    // `chiptuneFromJson` snaps cycleFrames to a musical (octave-aligned)
    // value on load; use a power-of-two so the round-trip is bit-exact.
    const params = { ...defaultChiptuneParams(), cycleFrames: 128 };
    const inputs = baseInputs({
      xmChiptuneSources: {
        "1:0": {
          params,
          chain: [],
          xm: { monoMix: "average", bitDepth: 8 },
        },
      },
    });
    const bytes = projectToBytes(inputs);
    const loaded = projectFromBytes(bytes);
    expect(loaded).not.toBeNull();
    const restored = loaded!.xmChiptuneSources["1:0"];
    expect(restored).toBeDefined();
    expect(restored!.params.cycleFrames).toBe(128);
    expect(restored!.xm.bitDepth).toBe(8);
  });

  it("round-trips an XM sampler workbench with chain + transformer params", async () => {
    const { writeWav, readWav } = await import("~/core/audio/wav");
    const wav = {
      sampleRate: 22050,
      channels: [new Float32Array([0, 0.25, 0.5, 0.25, 0, -0.25, -0.5, -0.25])],
    };
    const roundTrippedWav = readWav(writeWav(wav, { bitsPerSample: 16 }));
    const inputs = baseInputs({
      xmSamplerSources: {
        "3:1": {
          sourceName: "kick",
          wav: roundTrippedWav,
          chain: [{ kind: "normalize" }],
          xm: { monoMix: "left", bitDepth: 16, dither: true },
        },
      },
    });
    const bytes = projectToBytes(inputs);
    const loaded = projectFromBytes(bytes);
    expect(loaded).not.toBeNull();
    const restored = loaded!.xmSamplerSources["3:1"];
    expect(restored).toBeDefined();
    expect(restored!.sourceName).toBe("kick");
    expect(restored!.chain).toEqual([{ kind: "normalize" }]);
    expect(restored!.xm.bitDepth).toBe(16);
    expect(restored!.xm.monoMix).toBe("left");
    expect(restored!.xm.dither).toBe(true);
  });

  it("round-trips the length fit and resampler; drops malformed ones", async () => {
    const wav = { sampleRate: 22050, channels: [new Float32Array(8)] };
    const source = (xm: object) => ({
      sourceName: "loop",
      wav,
      chain: [],
      xm: xm as never,
    });
    const bytes = projectToBytes(
      baseInputs({
        xmSamplerSources: {
          "1:0": source({
            monoMix: "average",
            bitDepth: 16,
            playingLength: { ticks: 384, bpm: 140 },
            resampleMode: "filteredLinear",
          }),
          // No fit: parses to exactly the object it always did.
          "2:0": source({ monoMix: "average", bitDepth: 8 }),
          "3:0": source({
            monoMix: "average",
            bitDepth: 8,
            playingLength: { ticks: -4, bpm: 140 },
            resampleMode: "bogus",
          }),
          "4:0": source({
            monoMix: "average",
            bitDepth: 8,
            playingLength: { ticks: 96, bpm: 9000 },
          }),
        },
      }),
    );
    const loaded = projectFromBytes(bytes)!.xmSamplerSources;
    expect(loaded["1:0"]!.xm).toEqual({
      monoMix: "average",
      bitDepth: 16,
      playingLength: { ticks: 384, bpm: 140 },
      resampleMode: "filteredLinear",
    });
    expect(loaded["2:0"]!.xm).toEqual({ monoMix: "average", bitDepth: 8 });
    expect(loaded["3:0"]!.xm).toEqual({ monoMix: "average", bitDepth: 8 });
    expect(loaded["4:0"]!.xm).toEqual({ monoMix: "average", bitDepth: 8 });
  });

  it("malformed XM workbench keys are dropped silently", async () => {
    const { defaultChiptuneParams } = await import("~/core/audio/chiptune");
    const bytes = projectToBytes(baseInputs());
    const json = JSON.parse(new TextDecoder().decode(bytes));
    json.xmChiptuneSources = {
      "1:0": {
        params: defaultChiptuneParams(),
        chain: [],
        xm: { monoMix: "average", bitDepth: 8 },
      },
      "999:0": { params: {}, chain: [], xm: {} }, // out-of-range inst
      "1:99": { params: {}, chain: [], xm: {} }, // out-of-range sampleIdx
      malformed: { params: {}, chain: [], xm: {} }, // missing ":"
    };
    const tampered = new TextEncoder().encode(JSON.stringify(json));
    const loaded = projectFromBytes(tampered);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.xmChiptuneSources)).toEqual(["1:0"]);
  });

  it("round-trips pattern names, including indices past PT's 127", () => {
    const base = emptyXmSong();
    const song = {
      ...base,
      patterns: Array.from({ length: 200 }, () =>
        emptyXmPattern(64, base.channelCount),
      ),
    };
    const bytes = projectToBytes(
      baseInputs({ song, patternNames: { 0: "intro", 199: "outro" } }),
    );
    expect(projectFromBytes(bytes)!.patternNames).toEqual({
      0: "intro",
      199: "outro",
    });
  });

  it("drops names for patterns the song does not have", () => {
    const bytes = projectToBytes(
      baseInputs({ patternNames: { 0: "intro", 5: "ghost" } }),
    );
    expect(projectFromBytes(bytes)!.patternNames).toEqual({ 0: "intro" });
  });

  it("PT2 payload still round-trips (regression)", async () => {
    // The widening of SessionInputs.song to Song must not break the PT2 path.
    const { emptySong } = await import("~/core/mod/format");
    const song = emptySong();
    song.title = "Pt2";
    const bytes = projectToBytes({
      song,
      filename: "demo.mod",
      infoText: "",
      view: "pattern",
      cursor: { order: 0, row: 0, channel: 0, field: "note" },
      currentSample: 1,
      currentOctave: 2,
      editStep: 1,
    });
    const loaded = projectFromBytes(bytes);
    expect(loaded!.song.format).toBe("PT2");
  });
});
