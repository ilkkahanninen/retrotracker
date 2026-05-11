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
  copyXmSampleBytes,
  cutXmSampleBytes,
  pasteXmSampleBytes,
} from "../src/state/xmSampleEdit";
import {
  clearXmSampleClipboard,
  xmSampleClipboard,
} from "../src/state/xmSampleClipboard";
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
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seedSong);

describe("XM sample clipboard", () => {
  it("copyXmSampleBytes loads the current sample's bytes into the clipboard", () => {
    expect(xmSampleClipboard()).toBeNull();
    copyXmSampleBytes();
    const clip = xmSampleClipboard();
    expect(clip).not.toBeNull();
    expect(clip!.bits).toBe(8);
    expect(Array.from(clip!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(clip!.name).toBe("sa");
  });

  it("cutXmSampleBytes copies and empties the sample", () => {
    cutXmSampleBytes();
    const clip = xmSampleClipboard();
    expect(clip).not.toBeNull();
    expect(Array.from(clip!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(xm2Song()!.instruments[0]!.samples[0]!.data.length).toBe(0);
  });

  it("pasteXmSampleBytes drops clipboard into the current sample", () => {
    // First copy.
    copyXmSampleBytes();
    // Make a second instrument with an empty sample and switch to it.
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
    copyXmSampleBytes();
    const clip = xmSampleClipboard();
    expect(clip!.bits).toBe(16);
    expect(Array.from(clip!.data)).toEqual([1000, -2000, 3000]);
  });
});
