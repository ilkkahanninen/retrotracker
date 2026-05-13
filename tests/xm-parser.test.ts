import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { parseXm } from "~/core/xm/parser";
import { isXmFile } from "~/core/xm/sniff";
import type { XmNote, XmSample, XmSong } from "~/core/xm/types";
import { writeXm } from "~/core/xm/writer";

function makeSong(overrides: Partial<XmSong> = {}): XmSong {
  return { ...emptyXmSong(), ...overrides };
}

function setCell(
  song: XmSong,
  row: number,
  channel: number,
  note: XmNote,
): void {
  song.patterns[0]!.rows[row]![channel] = note;
}

describe("writeXm + parseXm round-trip", () => {
  it("round-trips a fresh empty XM song", () => {
    const original = makeSong({ title: "TestSong", channelCount: 4 });
    const bytes = writeXm(original);
    expect(isXmFile(bytes)).toBe(true);
    const restored = parseXm(bytes);
    expect(restored.format).toBe("FT2");
    expect(restored.title).toBe("TestSong");
    expect(restored.channelCount).toBe(4);
    expect(restored.patterns).toHaveLength(1);
    expect(restored.patterns[0]!.rowCount).toBe(64);
    expect(restored.patterns[0]!.rows).toHaveLength(64);
    expect(restored.patterns[0]!.rows[0]!).toHaveLength(4);
  });

  it("round-trips header fields verbatim", () => {
    const song = makeSong({
      title: "ABC",
      trackerName: "TestTracker",
      channelCount: 8,
      songLength: 3,
      restartPosition: 1,
      orders: [...[0, 0, 0], ...new Array(253).fill(0)],
      defaultTempo: 5,
      defaultBpm: 130,
      flags: { linearFreq: false },
    });
    const restored = parseXm(writeXm(song));
    expect(restored.title).toBe("ABC");
    expect(restored.trackerName).toBe("TestTracker");
    expect(restored.channelCount).toBe(8);
    expect(restored.songLength).toBe(3);
    expect(restored.restartPosition).toBe(1);
    expect(restored.defaultTempo).toBe(5);
    expect(restored.defaultBpm).toBe(130);
    expect(restored.flags.linearFreq).toBe(false);
  });

  it("round-trips populated pattern cells", () => {
    const song = makeSong({ channelCount: 4 });
    setCell(song, 0, 0, {
      note: 49,
      instrument: 1,
      volumeColumn: 0x70,
      effect: 0x0c,
      effectParam: 0x40,
    });
    setCell(song, 1, 2, {
      note: 60,
      instrument: 0,
      volumeColumn: 0,
      effect: 0,
      effectParam: 0,
    });
    setCell(song, 5, 3, {
      note: 0,
      instrument: 0,
      volumeColumn: 0,
      effect: 0x0a,
      effectParam: 0x05,
    });
    const restored = parseXm(writeXm(song));
    expect(restored.patterns[0]!.rows[0]![0]).toEqual({
      note: 49,
      instrument: 1,
      volumeColumn: 0x70,
      effect: 0x0c,
      effectParam: 0x40,
    });
    expect(restored.patterns[0]!.rows[1]![2]!.note).toBe(60);
    expect(restored.patterns[0]!.rows[5]![3]).toEqual({
      note: 0,
      instrument: 0,
      volumeColumn: 0,
      effect: 0x0a,
      effectParam: 0x05,
    });
  });

  it("round-trips an instrument with one 8-bit sample and full envelope", () => {
    const song = makeSong({ channelCount: 4 });
    const inst = emptyXmInstrument();
    inst.name = "Lead";
    const sampleData: XmSample = {
      name: "kick",
      data: new Int8Array([0, 50, 100, -50, -100, 0]),
      bits: 8,
      loopStart: 1,
      loopLength: 4,
      loopType: "ping-pong",
      volume: 48,
      finetune: 16,
      panning: 200,
      relativeNote: 12,
    };
    inst.samples = [sampleData];
    inst.volumeEnvelope = {
      enabled: true,
      sustainEnabled: true,
      loopEnabled: false,
      sustainPoint: 1,
      loopStart: 0,
      loopEnd: 0,
      points: [
        { tick: 0, value: 0 },
        { tick: 16, value: 64 },
        { tick: 64, value: 32 },
      ],
    };
    inst.vibratoType = "ramp-up";
    inst.vibratoSweep = 24;
    inst.vibratoDepth = 4;
    inst.vibratoRate = 8;
    inst.fadeout = 1024;
    song.instruments = [inst];

    const restored = parseXm(writeXm(song));
    expect(restored.instruments).toHaveLength(1);
    const r = restored.instruments[0]!;
    expect(r.name).toBe("Lead");
    expect(r.samples).toHaveLength(1);
    const s = r.samples[0]!;
    expect(s.name).toBe("kick");
    expect(s.bits).toBe(8);
    expect(Array.from(s.data as Int8Array)).toEqual([0, 50, 100, -50, -100, 0]);
    expect(s.loopStart).toBe(1);
    expect(s.loopLength).toBe(4);
    expect(s.loopType).toBe("ping-pong");
    expect(s.volume).toBe(48);
    expect(s.finetune).toBe(16);
    expect(s.panning).toBe(200);
    expect(s.relativeNote).toBe(12);
    expect(r.volumeEnvelope.enabled).toBe(true);
    expect(r.volumeEnvelope.sustainEnabled).toBe(true);
    expect(r.volumeEnvelope.loopEnabled).toBe(false);
    expect(r.volumeEnvelope.points).toEqual([
      { tick: 0, value: 0 },
      { tick: 16, value: 64 },
      { tick: 64, value: 32 },
    ]);
    expect(r.vibratoType).toBe("ramp-up");
    expect(r.vibratoSweep).toBe(24);
    expect(r.vibratoDepth).toBe(4);
    expect(r.vibratoRate).toBe(8);
    expect(r.fadeout).toBe(1024);
  });

  it("round-trips a 16-bit sample with the right loop conversion", () => {
    const song = makeSong({ channelCount: 4 });
    const inst = emptyXmInstrument();
    inst.name = "Pad";
    inst.samples = [
      {
        name: "pad-sample",
        data: new Int16Array([0, 1000, -1000, 32767, -32768, 0]),
        bits: 16,
        loopStart: 2,
        loopLength: 3,
        loopType: "forward",
        volume: 64,
        finetune: -32,
        panning: 128,
        relativeNote: 0,
      },
    ];
    song.instruments = [inst];

    const restored = parseXm(writeXm(song));
    const s = restored.instruments[0]!.samples[0]!;
    expect(s.bits).toBe(16);
    expect(Array.from(s.data as Int16Array)).toEqual([
      0, 1000, -1000, 32767, -32768, 0,
    ]);
    expect(s.loopStart).toBe(2);
    expect(s.loopLength).toBe(3);
    expect(s.loopType).toBe("forward");
    expect(s.finetune).toBe(-32);
  });

  it("byte-stable round-trip (writeXm is its own inverse modulo parseXm)", () => {
    const song = makeSong({ title: "RT", channelCount: 4 });
    const inst = emptyXmInstrument();
    inst.name = "Inst1";
    inst.samples = [
      {
        name: "s1",
        data: new Int8Array([0, 10, -10, 5]),
        bits: 8,
        loopStart: 0,
        loopLength: 0,
        loopType: "none",
        volume: 32,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ];
    song.instruments = [inst];
    const first = writeXm(song);
    const second = writeXm(parseXm(first));
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it("rejects non-XM bytes", () => {
    const bytes = new TextEncoder().encode("Not an XM file at all");
    expect(() => parseXm(bytes)).toThrow(/XM/);
  });

  it("rejects unsupported XM versions", () => {
    const song = makeSong();
    const bytes = writeXm(song);
    // Stomp the version field at offset 58 to 0x0103.
    bytes[58] = 0x03;
    bytes[59] = 0x01;
    expect(() => parseXm(bytes)).toThrow(/version/);
  });
});
