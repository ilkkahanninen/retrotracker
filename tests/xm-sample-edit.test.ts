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
  addXmEffect,
  applyXmChainToSource,
  removeXmEffect,
  setXmBitDepth,
} from "../src/state/xmSampleEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
} from "../src/state/xmSampleWorkbench";
import type { XmSong } from "../src/core/xm/types";

function seedSong(): XmSong {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  // Give the sample a tiny non-empty payload so the chain has something
  // to work with.
  inst.samples[0]!.data = new Int8Array([10, 20, 30, 40, 50]);
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearHistory();
  clearAllXmWorkbenches();
  return s;
}

beforeEach(seedSong);

describe("xmSampleEdit", () => {
  it("addXmEffect lazy-creates a workbench and appends the effect", () => {
    expect(getXmWorkbench(1, 0)).toBeUndefined();
    addXmEffect("normalize");
    const wb = getXmWorkbench(1, 0);
    expect(wb).toBeDefined();
    expect(wb!.chain.length).toBe(1);
    expect(wb!.chain[0]!.kind).toBe("normalize");
  });

  it("removeXmEffect drops the chain entry", () => {
    addXmEffect("normalize");
    addXmEffect("reverse");
    expect(getXmWorkbench(1, 0)!.chain.length).toBe(2);
    removeXmEffect(0);
    const wb = getXmWorkbench(1, 0)!;
    expect(wb.chain.length).toBe(1);
    expect(wb.chain[0]!.kind).toBe("reverse");
  });

  it("setXmBitDepth flips the terminal stage's output bit depth", () => {
    addXmEffect("normalize");
    setXmBitDepth(16);
    const wb = getXmWorkbench(1, 0)!;
    expect(wb.xm.bitDepth).toBe(16);
    // The sample's bit depth field should now match.
    expect(xm2Song()!.instruments[0]!.samples[0]!.bits).toBe(16);
  });

  it("applyXmChainToSource burns the chain into the source", () => {
    addXmEffect("normalize");
    expect(getXmWorkbench(1, 0)!.chain.length).toBe(1);
    applyXmChainToSource();
    const wb = getXmWorkbench(1, 0)!;
    expect(wb.chain.length).toBe(0);
    // The source is now a sampler wrapping the post-chain WavData.
    expect(wb.source.kind).toBe("sampler");
  });
});
