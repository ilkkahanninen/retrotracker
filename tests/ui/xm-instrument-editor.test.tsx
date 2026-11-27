import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { InstrumentView } from "../../src/components/InstrumentView";
import { sampleOffsetParam } from "../../src/components/sampleEditorShared";
import { xmWorkbenchFromChiptune } from "../../src/core/audio/sampleWorkbench";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import {
  clearHistory,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import { setView } from "../../src/state/view";
import {
  currentXmSampleIndex,
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { patchXmSample } from "../../src/state/xmInstrumentEdit";
import { addXmEffect } from "../../src/state/xmSampleEdit";
import {
  clearXmSampleSelection,
  setXmSampleSelection,
  xmSampleSelection,
} from "../../src/state/xmSampleSelection";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
  setXmWorkbench,
} from "../../src/state/xmSampleWorkbench";

/**
 * Smaller FT2 instrument-editor behaviours that PT's sample view already
 * had: selection-aware Reverse, a loop range that survives a loop-type
 * change, focus released after a dropdown, the waveform hover readout,
 * per-sample Clear / Duplicate, and the chiptune-mode rules.
 */

const LEN = 2048;

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  const data = new Int8Array(LEN);
  for (let i = 0; i < LEN; i++) data[i] = (i % 100) - 50;
  inst.samples[0] = { ...inst.samples[0]!, data, bits: 8, name: "one" };
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  setView("sample");
  clearXmSampleSelection();
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seed);
afterEach(() => {
  cleanup();
  setSong(null);
  setView("pattern");
  clearHistory();
});

const sample = (idx = 0) => xm2Song()!.instruments[0]!.samples[idx]!;

/** The sample's own Loop dropdown (the envelopes have loop controls too). */
function sampleLoopSelect(container: HTMLElement): HTMLSelectElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (l) => l.querySelector(".samplemeta__label")?.textContent === "Loop",
  );
  return label!.querySelector("select")!;
}
const mountView = () => render(() => <InstrumentView song={xm2Song()!} />);

describe("Reverse and the waveform selection", () => {
  it("reverses only the selected range", () => {
    const before = Array.from(sample().data);
    addXmEffect("reverse", { start: 100, end: 200 });
    const after = Array.from(sample().data);
    expect(after.slice(0, 100)).toEqual(before.slice(0, 100));
    expect(after.slice(100, 200)).toEqual(before.slice(100, 200).reverse());
    expect(after.slice(200)).toEqual(before.slice(200));
    expect(getXmWorkbench(1, 0)!.chain[0]).toEqual({
      kind: "reverse",
      params: { startFrame: 100, endFrame: 200 },
    });
  });

  it("reverses the whole sample without a selection", () => {
    const before = Array.from(sample().data);
    addXmEffect("reverse", null);
    expect(Array.from(sample().data)).toEqual(before.reverse());
  });

  it("the Reverse button passes the selection through", () => {
    const view = mountView();
    setXmSampleSelection({ start: 100, end: 200 });
    fireEvent.click(view.getByRole("button", { name: "Reverse" }));
    expect(getXmWorkbench(1, 0)!.chain[0]).toMatchObject({
      params: { startFrame: 100, endFrame: 200 },
    });
  });

  it("other effects ignore the selection", () => {
    addXmEffect("normalize", { start: 100, end: 200 });
    expect(getXmWorkbench(1, 0)!.chain[0]!.kind).toBe("normalize");
  });
});

describe("loop type and the loop range", () => {
  const loopSelect = (view: ReturnType<typeof mountView>) =>
    sampleLoopSelect(view.container);

  it("forward → ping-pong keeps a placed loop", () => {
    patchXmSample(
      1,
      { loopType: "forward", loopStart: 300, loopLength: 500 },
      0,
    );
    const view = mountView();
    fireEvent.change(loopSelect(view), { target: { value: "ping-pong" } });
    expect(sample()).toMatchObject({
      loopType: "ping-pong",
      loopStart: 300,
      loopLength: 500,
    });
  });

  it("off and back on restores the range", () => {
    patchXmSample(
      1,
      { loopType: "forward", loopStart: 300, loopLength: 500 },
      0,
    );
    const view = mountView();
    fireEvent.change(loopSelect(view), { target: { value: "none" } });
    expect(sample().loopType).toBe("none");
    fireEvent.change(loopSelect(view), { target: { value: "forward" } });
    expect(sample()).toMatchObject({
      loopType: "forward",
      loopStart: 300,
      loopLength: 500,
    });
  });

  it("a selection still wins, and a never-looped sample gets the whole range", () => {
    const view = mountView();
    fireEvent.change(loopSelect(view), { target: { value: "forward" } });
    expect(sample()).toMatchObject({ loopStart: 0, loopLength: LEN });
    setXmSampleSelection({ start: 10, end: 60 });
    fireEvent.change(loopSelect(view), { target: { value: "ping-pong" } });
    expect(sample()).toMatchObject({ loopStart: 10, loopLength: 50 });
    expect(xmSampleSelection()).toBeNull();
  });
});

describe("focus after a dropdown", () => {
  it("is released, so piano keys reach the shortcuts again", () => {
    const view = mountView();
    const select = sampleLoopSelect(view.container);
    select.focus();
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: "forward" } });
    expect(document.activeElement).not.toBe(select);
  });
});

describe("waveform hover readout", () => {
  it("shows the frame under the pointer and its 9xx command", () => {
    const view = mountView();
    const wrap = view.container.querySelector(".xm-waveform-wrap")!;
    wrap.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1024,
        height: 90,
        right: 1024,
        bottom: 90,
      }) as DOMRect;
    expect(view.container.querySelector(".waveform__cursor-info")).toBeNull();
    // Half way across a 2048-frame sample.
    fireEvent.mouseMove(wrap, { clientX: 512, clientY: 20 });
    const info = view.container.querySelector(".waveform__cursor-info")!;
    expect(info.textContent).toContain("Frame: 1024");
    expect(info.textContent).toContain("cmd: 904");
    fireEvent.mouseLeave(wrap);
    expect(view.container.querySelector(".waveform__cursor-info")).toBeNull();
  });

  it("9xx steps 256 frames and saturates at 9FF", () => {
    expect(sampleOffsetParam(0)).toBe("900");
    expect(sampleOffsetParam(255)).toBe("900");
    expect(sampleOffsetParam(256)).toBe("901");
    expect(sampleOffsetParam(0x1234)).toBe("912");
    expect(sampleOffsetParam(1_000_000)).toBe("9FF");
  });
});

describe("per-sample Clear and Duplicate", () => {
  it("Duplicate adds a copy of the current sample and selects it", () => {
    const view = mountView();
    fireEvent.click(view.getByRole("button", { name: "Duplicate sample" }));
    expect(xm2Song()!.instruments[0]!.samples).toHaveLength(2);
    expect(Array.from(sample(1).data)).toEqual(Array.from(sample(0).data));
    expect(currentXmSampleIndex()).toBe(1);
  });

  it("Clear empties the current sample and leaves the instrument alone", () => {
    const view = mountView();
    fireEvent.click(view.getByRole("button", { name: "Duplicate sample" }));
    const fadeout = xm2Song()!.instruments[0]!.fadeout;
    fireEvent.click(view.getByRole("button", { name: "Clear sample" }));
    expect(sample(1).data.length).toBe(0);
    expect(sample(0).data.length).toBe(LEN);
    expect(xm2Song()!.instruments[0]!.fadeout).toBe(fadeout);
  });

  it("both are disabled on an empty sample", () => {
    setSong({ ...emptyXmSong(), instruments: [emptyXmInstrument()] });
    const view = mountView();
    expect(
      (
        view.getByRole("button", {
          name: "Duplicate sample",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "Clear sample" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("chiptune mode", () => {
  it("drops a selection left over from the sampler half", () => {
    mountView();
    setXmSampleSelection({ start: 10, end: 60 });
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    expect(xmSampleSelection()).toBeNull();
  });

  it("Cmd+A selects nothing on a chiptune source", async () => {
    setXmWorkbench(1, 0, xmWorkbenchFromChiptune());
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(xmSampleSelection()).toBeNull();
  });

  it("Cmd+A still selects the whole sample on a sampler source", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(xmSampleSelection()).toEqual({ start: 0, end: LEN });
  });
});

describe("pipeline header before the first edit", () => {
  it("reports the rate the sample plays at, not a fixed 8363 Hz", () => {
    // Tuned an octave up: C-4 reads the data at 16726 Hz.
    patchXmSample(1, { relativeNote: 12 }, 0);
    clearAllXmWorkbenches();
    const view = mountView();
    expect(
      view.container.querySelector(".pipeline__source")!.textContent,
    ).toContain("16726 Hz");
  });
});
