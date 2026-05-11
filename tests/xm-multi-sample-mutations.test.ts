import { describe, expect, it } from "vitest";

import {
  emptyXmInstrument,
  emptyXmSample,
  emptyXmSong,
} from "../src/core/xm/format";
import {
  addXmInstrumentSample,
  patchXmInstrumentSample,
  removeXmInstrumentSample,
  setXmInstrumentKeyMap,
  setXmInstrumentSample,
} from "../src/core/xm/mutations";
import type { XmSong } from "../src/core/xm/types";

function seedSongWithInstrument(): XmSong {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  // Default has one sample. Mark it so we can assert on identity.
  inst.samples[0]!.name = "first";
  s.instruments = [inst];
  return s;
}

describe("addXmInstrumentSample", () => {
  it("appends an empty sample slot", () => {
    const s1 = seedSongWithInstrument();
    const s2 = addXmInstrumentSample(s1, 1);
    expect(s2.instruments[0]!.samples.length).toBe(2);
    expect(s2.instruments[0]!.samples[1]!.name).toBe("");
  });

  it("caps at 16 samples per instrument", () => {
    let s = seedSongWithInstrument();
    for (let i = 0; i < 30; i++) s = addXmInstrumentSample(s, 1);
    expect(s.instruments[0]!.samples.length).toBe(16);
  });
});

describe("removeXmInstrumentSample", () => {
  it("removes the indexed sample", () => {
    let s = seedSongWithInstrument();
    s = addXmInstrumentSample(s, 1);
    s = patchXmInstrumentSample(s, 1, { name: "second" }, 1);
    expect(s.instruments[0]!.samples[1]!.name).toBe("second");
    s = removeXmInstrumentSample(s, 1, 0);
    expect(s.instruments[0]!.samples.length).toBe(1);
    expect(s.instruments[0]!.samples[0]!.name).toBe("second");
  });

  it("never empties the sample list", () => {
    const s1 = seedSongWithInstrument();
    const s2 = removeXmInstrumentSample(s1, 1, 0);
    expect(s2.instruments[0]!.samples.length).toBe(1);
  });

  it("re-anchors keymap entries that referenced the removed sample to 0", () => {
    let s = seedSongWithInstrument();
    s = addXmInstrumentSample(s, 1);
    s = addXmInstrumentSample(s, 1);
    // Set keyMap[10] → sample 1, keyMap[11] → sample 2.
    const km = new Uint8Array(96);
    km[10] = 1;
    km[11] = 2;
    s = setXmInstrumentKeyMap(s, 1, km);
    // Remove sample 1 — entry that pointed at it falls back to 0,
    // the entry that pointed at 2 shifts down to 1.
    s = removeXmInstrumentSample(s, 1, 1);
    expect(s.instruments[0]!.keyMap[10]).toBe(0);
    expect(s.instruments[0]!.keyMap[11]).toBe(1);
  });
});

describe("setXmInstrumentSample with sampleIndex", () => {
  it("targets the indexed slot", () => {
    let s = seedSongWithInstrument();
    s = addXmInstrumentSample(s, 1);
    const fresh = { ...emptyXmSample(), name: "swapped" };
    s = setXmInstrumentSample(s, 1, fresh, 1);
    expect(s.instruments[0]!.samples[0]!.name).toBe("first");
    expect(s.instruments[0]!.samples[1]!.name).toBe("swapped");
  });

  it("auto-appends when index is one past the end", () => {
    let s = seedSongWithInstrument();
    const fresh = { ...emptyXmSample(), name: "appended" };
    s = setXmInstrumentSample(s, 1, fresh, 1);
    expect(s.instruments[0]!.samples.length).toBe(2);
    expect(s.instruments[0]!.samples[1]!.name).toBe("appended");
  });
});

describe("patchXmInstrumentSample with sampleIndex", () => {
  it("patches the indexed sample only", () => {
    let s = seedSongWithInstrument();
    s = addXmInstrumentSample(s, 1);
    s = patchXmInstrumentSample(s, 1, { volume: 40 }, 1);
    expect(s.instruments[0]!.samples[0]!.volume).toBe(64); // unchanged
    expect(s.instruments[0]!.samples[1]!.volume).toBe(40);
  });
});

describe("setXmInstrumentKeyMap", () => {
  it("clamps each entry to a valid sample index", () => {
    let s = seedSongWithInstrument();
    s = addXmInstrumentSample(s, 1); // now 2 samples
    const km = new Uint8Array(96);
    km[0] = 5; // out of range → clamps to 1 (samples.length - 1)
    km[1] = 1;
    s = setXmInstrumentKeyMap(s, 1, km);
    expect(s.instruments[0]!.keyMap[0]).toBe(1);
    expect(s.instruments[0]!.keyMap[1]).toBe(1);
  });

  it("copies the input so caller mutations don't leak", () => {
    const s1 = seedSongWithInstrument();
    const km = new Uint8Array(96);
    km[0] = 0; // no-op for samples.length == 1, but exercise the copy
    const s2 = setXmInstrumentKeyMap(s1, 1, km);
    km[0] = 7; // mutate caller buffer
    expect(s2.instruments[0]!.keyMap[0]).toBe(0);
  });
});
