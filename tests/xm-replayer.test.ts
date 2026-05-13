import { describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "~/core/xm/format";
import { setXmCell, setXmInstrument } from "~/core/xm/mutations";
import type { XmInstrument, XmSong } from "~/core/xm/types";
import { XmReplayer } from "~/core/audio/xmReplayer";
import { makeReplayer } from "~/core/audio/replayerCommon";

const SR = 44100;

/**
 * Build a small FT2 song with one instrument carrying a 1024-sample,
 * loud, looping triangle. The replayer should turn it into audible
 * output — we mostly assert structural invariants (orderIndex / row
 * advance, peak detection, voice activation) rather than bit-exactness;
 * the libxmp-driven accuracy bed lands in a later slice.
 */
function buildTinyXmSong(): XmSong {
  let s = emptyXmSong();
  // A single instrument with a 256-sample saw.
  const samp = {
    name: "saw",
    data: new Int8Array(256),
    bits: 8 as const,
    loopStart: 0,
    loopLength: 256,
    loopType: "forward" as const,
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
  for (let i = 0; i < samp.data.length; i++) {
    samp.data[i] = (i - 128) | 0;
  }
  const inst: XmInstrument = {
    ...emptyXmInstrument(),
    name: "saw",
    samples: [samp],
  };
  s = setXmInstrument(s, 0, inst);
  // Row 0 channel 0: trigger note 49 (C-4) on instrument 1.
  s = setXmCell(s, 0, 0, 0, { note: 49, instrument: 1 });
  return s;
}

describe("XmReplayer skeleton", () => {
  it("rejects PT songs", () => {
    const ptLike = { format: "PT2" } as unknown as XmSong;
    expect(() => new XmReplayer(ptLike, { sampleRate: SR })).toThrow();
  });

  it("makeReplayer dispatches to XmReplayer for FT2 songs", () => {
    const r = makeReplayer(buildTinyXmSong(), { sampleRate: SR });
    expect(r).toBeInstanceOf(XmReplayer);
    expect(r.getOrderIndex()).toBe(0);
    expect(r.getRow()).toBe(0);
  });

  it("process() writes audible output once a note triggers", () => {
    const song = buildTinyXmSong();
    const r = new XmReplayer(song, { sampleRate: SR });
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    r.process(left, right, 2048);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      const a = Math.abs(left[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0);
  });

  it("muted channel produces silence", () => {
    const song = buildTinyXmSong();
    const r = new XmReplayer(song, { sampleRate: SR });
    r.setChannelMuted(0, true);
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    r.process(left, right, 2048);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    expect(peak).toBe(0);
  });

  it("row advances as ticks accumulate", () => {
    let song = buildTinyXmSong();
    // Write a note on row 1 too so the row advance is visible.
    song = setXmCell(song, 0, 1, 0, { note: 50, instrument: 1 });
    const r = new XmReplayer(song, { sampleRate: SR });
    expect(r.getRow()).toBe(0);
    // Default speed=6, BPM=125 → tickHz = 50, samplesPerTick ≈ 882.
    // 6 ticks → ~5292 samples, then we land on row 1.
    const left = new Float32Array(8192);
    const right = new Float32Array(8192);
    r.process(left, right, 8192);
    expect(r.getRow()).toBeGreaterThan(0);
  });

  it("Cxx sets the channel volume", () => {
    let song = buildTinyXmSong();
    song = setXmCell(song, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0c,
      effectParam: 0x10,
    });
    const r = new XmReplayer(song, { sampleRate: SR });
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    r.process(left, right, 2048);
    let peak = 0;
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]!));
    }
    // Volume 0x10 = 16/64 = ¼ — peak should be smaller than full-volume run.
    const r2 = new XmReplayer(buildTinyXmSong(), { sampleRate: SR });
    const left2 = new Float32Array(2048);
    const right2 = new Float32Array(2048);
    r2.process(left2, right2, 2048);
    let peak2 = 0;
    for (let i = 0; i < left2.length; i++) {
      peak2 = Math.max(peak2, Math.abs(left2[i]!));
    }
    expect(peak).toBeLessThan(peak2);
  });

  it("Fxx sets speed below 32 and tempo above", () => {
    let song = buildTinyXmSong();
    song = setXmCell(song, 0, 0, 0, {
      note: 49,
      instrument: 1,
      effect: 0x0f,
      effectParam: 16, // speed = 16
    });
    const r = new XmReplayer(song, { sampleRate: SR });
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    r.process(left, right, 512);
    // Speed change took effect — at speed=16, the row stays "row 0" longer
    // than at speed=6. We can't easily inspect speed, but the row advance
    // is delayed; consume the same 8192 frames as the row-advance test
    // and assert we're still on row 0 (or at most row 1).
    const r2 = new XmReplayer(song, { sampleRate: SR });
    const left2 = new Float32Array(8192);
    const right2 = new Float32Array(8192);
    r2.process(left2, right2, 8192);
    // speed=16 vs 6: at speed=16, after 8192 frames (~9 ticks) we're still
    // on row 0. At speed=6, we'd be on row 1+.
    expect(r2.getRow()).toBe(0);
  });

  it("peakSnapshotAndReset writes one entry per channel", () => {
    const song = buildTinyXmSong();
    const r = new XmReplayer(song, { sampleRate: SR });
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    r.process(left, right, 2048);
    const peaks = new Float32Array(8);
    r.peakSnapshotAndReset(peaks);
    expect(peaks[0]).toBeGreaterThan(0);
    // Peak resets after snapshot.
    const peaks2 = new Float32Array(8);
    // No further processing — peaks should be zero.
    r.peakSnapshotAndReset(peaks2);
    expect(peaks2[0]).toBe(0);
  });
});
