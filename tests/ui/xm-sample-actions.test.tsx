import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";

import { InstrumentView } from "../../src/components/InstrumentView";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import {
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.name = "sa";
  inst.samples[0]!.data = new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  inst.samples[0]!.bits = 8;
  inst.samples[0]!.volume = 50;
  inst.samples[0]!.finetune = 12;
  inst.samples[0]!.loopStart = 2;
  inst.samples[0]!.loopLength = 4;
  inst.samples[0]!.loopType = "forward";
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seed);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

function mountView() {
  const song = () => xm2Song()!;
  return render(() => <InstrumentView song={song()} />);
}

function findActionButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      ".sampleview__actions button",
    ),
  ).find((b) => b.textContent?.trim() === label);
}

describe("InstrumentView header action buttons", () => {
  it("Duplicate sample appends a copy with the same data and switches to it", () => {
    const view = mountView();
    const dup = findActionButton(view.container, "Duplicate sample");
    expect(dup).toBeDefined();
    expect(dup!.disabled).toBe(false);
    fireEvent.click(dup!);
    const samples = xm2Song()!.instruments[0]!.samples;
    expect(samples.length).toBe(2);
    expect(Array.from(samples[1]!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The copy carries over per-sample metadata (volume, loop, …).
    expect(samples[1]!.volume).toBe(50);
    expect(samples[1]!.loopStart).toBe(2);
    expect(samples[1]!.loopLength).toBe(4);
    // Name is suffixed " copy" so the chip strip distinguishes them.
    expect(samples[1]!.name).toBe("sa copy");
    // The active sample switched to the new one so the user lands on
    // the duplicate.
    expect(currentXmSampleIndex()).toBe(1);
  });

  it("Clear instrument wipes the entire instrument (samples, name, tuning)", () => {
    const view = mountView();
    const clear = findActionButton(view.container, "Clear instrument");
    expect(clear).toBeDefined();
    fireEvent.click(clear!);
    const inst = xm2Song()!.instruments[0]!;
    // Name is gone, samples reset to a fresh empty one.
    expect(inst.name).toBe("");
    expect(inst.samples.length).toBe(1);
    expect(inst.samples[0]!.data.length).toBe(0);
    expect(inst.samples[0]!.loopLength).toBe(0);
    expect(inst.samples[0]!.loopType).toBe("none");
    // Tuning resets too — clear is a full wipe.
    expect(inst.samples[0]!.volume).toBe(64);
    expect(inst.samples[0]!.finetune).toBe(0);
  });

  it("Load WAV button is reachable from the header in sampler mode", () => {
    const view = mountView();
    const load = findActionButton(view.container, "Load WAV…");
    expect(load).toBeDefined();
    expect(load!.disabled).toBe(false);
  });
});
