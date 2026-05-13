import { beforeEach, describe, expect, it } from "vitest";

import { emptyXmInstrument, emptyXmSong } from "../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../src/state/xmEdit";
import {
  copyXmSampleRange,
  cropXmCurrentSampleToSelection,
  cutXmCurrentSampleSelection,
  cutXmSampleRange,
  effectiveXmSampleRange,
  pasteXmSampleBytes,
} from "../src/state/xmSampleEdit";
import {
  clearXmSampleClipboard,
  xmSampleClipboard,
} from "../src/state/xmSampleClipboard";
import {
  clearXmSampleSelection,
  setXmSampleSelection,
} from "../src/state/xmSampleSelection";
import { clearAllXmWorkbenches } from "../src/state/xmSampleWorkbench";

function seedSong() {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.data = new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  inst.samples[0]!.bits = 8;
  inst.samples[0]!.name = "sa";
  s.instruments = [inst];
  setSong(s);
  setTransport("idle");
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  clearXmSampleClipboard();
  clearXmSampleSelection();
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seedSong);

describe("XM sample clipboard (whole-sample)", () => {
  it("copyXmSampleRange covers the whole buffer when called with [0, len)", () => {
    expect(xmSampleClipboard()).toBeNull();
    copyXmSampleRange(0, 8);
    const clip = xmSampleClipboard();
    expect(clip).not.toBeNull();
    expect(clip!.bits).toBe(8);
    expect(Array.from(clip!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(clip!.name).toBe("sa");
  });

  it("cutXmSampleRange copies and removes the whole buffer", () => {
    cutXmSampleRange(0, 8);
    const clip = xmSampleClipboard();
    expect(clip).not.toBeNull();
    expect(Array.from(clip!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(xm2Song()!.instruments[0]!.samples[0]!.data.length).toBe(0);
  });

  it("pasteXmSampleBytes drops clipboard into the current sample", () => {
    copyXmSampleRange(0, 8);
    const s = xm2Song()!;
    const second = emptyXmInstrument();
    second.name = "ins-b";
    setSong({ ...s, instruments: [s.instruments[0]!, second] });
    setCurrentXmInstrument(2);
    setCurrentXmSampleIndex(0);
    expect(xm2Song()!.instruments[1]!.samples[0]!.data.length).toBe(0);
    pasteXmSampleBytes();
    expect(Array.from(xm2Song()!.instruments[1]!.samples[0]!.data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(xm2Song()!.instruments[1]!.samples[0]!.bits).toBe(8);
  });

  it("pasteXmSampleBytes is a no-op when clipboard is empty", () => {
    expect(xmSampleClipboard()).toBeNull();
    pasteXmSampleBytes();
    expect(Array.from(xm2Song()!.instruments[0]!.samples[0]!.data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("16-bit copies preserve the wider precision through paste", () => {
    const s = xm2Song()!;
    s.instruments[0]!.samples[0]!.data = new Int16Array([1000, -2000, 3000]);
    s.instruments[0]!.samples[0]!.bits = 16;
    setSong({ ...s });
    copyXmSampleRange(0, 3);
    const clip = xmSampleClipboard();
    expect(clip!.bits).toBe(16);
    expect(Array.from(clip!.data)).toEqual([1000, -2000, 3000]);
  });
});

describe("XM sample selection + range edits", () => {
  it("effectiveXmSampleRange returns the selection when active", () => {
    setXmSampleSelection({ start: 2, end: 5 });
    expect(effectiveXmSampleRange()).toEqual({ start: 2, end: 5 });
  });

  it("effectiveXmSampleRange falls back to whole sample when no selection", () => {
    expect(effectiveXmSampleRange()).toEqual({ start: 0, end: 8 });
  });

  it("effectiveXmSampleRange clamps an out-of-bounds selection to the sample", () => {
    setXmSampleSelection({ start: -3, end: 999 });
    expect(effectiveXmSampleRange()).toEqual({ start: 0, end: 8 });
  });

  it("copyXmSampleRange copies the selected frames only", () => {
    copyXmSampleRange(2, 5);
    expect(Array.from(xmSampleClipboard()!.data)).toEqual([3, 4, 5]);
  });

  it("cutXmCurrentSampleSelection removes [2, 5) and pulls the tail forward", () => {
    cutXmCurrentSampleSelection(2, 5);
    expect(Array.from(xm2Song()!.instruments[0]!.samples[0]!.data)).toEqual([
      1, 2, 6, 7, 8,
    ]);
  });

  it("cropXmCurrentSampleToSelection trims the buffer to the selection", () => {
    cropXmCurrentSampleToSelection(2, 6);
    expect(Array.from(xm2Song()!.instruments[0]!.samples[0]!.data)).toEqual([
      3, 4, 5, 6,
    ]);
  });

  it("crop clamps loop fields into the new (shorter) buffer", () => {
    const s = xm2Song()!;
    s.instruments[0]!.samples[0]!.loopStart = 1;
    s.instruments[0]!.samples[0]!.loopLength = 6;
    s.instruments[0]!.samples[0]!.loopType = "forward";
    setSong({ ...s });
    cropXmCurrentSampleToSelection(2, 6); // keeps frames 2..5 → 4 frames
    const sample = xm2Song()!.instruments[0]!.samples[0]!;
    // Crop is non-destructive (it's an effect node on the chain), so
    // loop fields stay in the sample's original tick-space and just
    // clamp to the new shorter buffer. loopStart=1 stays at 1; the
    // remaining buffer after loopStart is 3 frames, so loopLength
    // clamps from 6 down to 3.
    expect(sample.loopStart).toBe(1);
    expect(sample.loopLength).toBe(3);
    expect(sample.loopType).toBe("forward");
  });

  it("crop dropping the entire loop region falls back to loopType=none", () => {
    const s = xm2Song()!;
    s.instruments[0]!.samples[0]!.loopStart = 6;
    s.instruments[0]!.samples[0]!.loopLength = 2;
    s.instruments[0]!.samples[0]!.loopType = "forward";
    setSong({ ...s });
    cropXmCurrentSampleToSelection(0, 4); // chain output now 4 frames
    const sample = xm2Song()!.instruments[0]!.samples[0]!;
    // loopStart=6 clamps into the 4-frame buffer → 3; loopLength=2
    // collapses to 0 because there are only `data.length - loopStart`
    // = 1 frame past the (clamped) start. loopType flips to "none".
    expect(sample.loopLength).toBe(0);
    expect(sample.loopType).toBe("none");
  });

  it("crop clears the selection so the overlay doesn't paint stale", () => {
    setXmSampleSelection({ start: 2, end: 6 });
    cropXmCurrentSampleToSelection(2, 6);
    // After crop the buffer is 4 frames; the selection is cleared.
    // We assert via effectiveXmSampleRange falling back to whole-sample.
    expect(effectiveXmSampleRange()).toEqual({ start: 0, end: 4 });
  });

  it("crop is non-destructive — removing the chain effect restores the original data", async () => {
    cropXmCurrentSampleToSelection(2, 6);
    expect(xm2Song()!.instruments[0]!.samples[0]!.data.length).toBe(4);
    // The chain now carries the crop effect; remove it to undo.
    const { removeXmEffect } = await import("../src/state/xmSampleEdit");
    removeXmEffect(0);
    expect(Array.from(xm2Song()!.instruments[0]!.samples[0]!.data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});
