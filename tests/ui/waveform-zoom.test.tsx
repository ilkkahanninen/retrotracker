import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { App } from "../../src/App";
import { emptySong } from "../../src/core/mod/format";
import { emptyXmInstrument, emptyXmSong } from "../../src/core/xm/format";
import { setCurrentSample } from "../../src/state/edit";
import {
  sampleSelection,
  setSampleSelection,
} from "../../src/state/sampleSelection";
import { clearHistory, setSong, setTransport } from "../../src/state/song";
import { setView } from "../../src/state/view";
import {
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { patchXmSample } from "../../src/state/xmInstrumentEdit";
import {
  clearXmSampleSelection,
  xmSampleSelection,
} from "../../src/state/xmSampleSelection";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";

/**
 * Wheel zoom on the sample waveform, for both formats — they share
 * `createWaveformViewport`. The canvas doesn't paint in jsdom, so the
 * viewport is observed through what a click selects: pressing at the
 * canvas's left edge anchors a selection at the first visible frame.
 */

const LEN = 4096;
/** Canvas-internal width; the stubbed rect makes client X map 1:1. */
const W = 1024;

function stubRect(el: Element): void {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: W,
      bottom: 100,
      width: W,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function reset(): void {
  setSong(null);
  setTransport("idle");
  setView("pattern");
  setCurrentSample(1);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setSampleSelection(null);
  clearXmSampleSelection();
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

/** Press and release at canvas X `x`; returns nothing — read the
 *  selection signal while the button is down via `during`. */
function pressAt(el: Element, x: number, during: () => void): void {
  fireEvent.mouseDown(el, { clientX: x });
  during();
  fireEvent.mouseUp(window);
}

describe("FT2 waveform zoom", () => {
  function mount(): Element {
    const s = emptyXmSong();
    const inst = emptyXmInstrument();
    inst.samples[0]!.data = new Int8Array(LEN);
    inst.samples[0]!.bits = 8;
    s.instruments = [inst];
    setSong(s);
    setView("sample");
    const { container } = render(() => <App />);
    const wrap = container.querySelector(".xm-waveform-wrap")!;
    stubRect(wrap);
    return wrap;
  }

  const firstVisibleFrame = (wrap: Element): number => {
    let start = -1;
    pressAt(wrap, 0, () => (start = xmSampleSelection()!.start));
    return start;
  };
  const lastVisibleFrame = (wrap: Element): number => {
    let start = -1;
    pressAt(wrap, W, () => (start = xmSampleSelection()!.start));
    return start;
  };

  it("shows the whole sample until zoomed", () => {
    const wrap = mount();
    expect(firstVisibleFrame(wrap)).toBe(0);
    expect(lastVisibleFrame(wrap)).toBe(LEN);
  });

  it("wheel up zooms in around the pointer", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -100, clientX: W / 2 });
    const first = firstVisibleFrame(wrap);
    const last = lastVisibleFrame(wrap);
    // One wheel click is ~×1.65 per step at the tuned sensitivity.
    expect(last - first).toBeLessThan(LEN / 2);
    expect(last - first).toBeGreaterThan(LEN / 8);
    // Anchored at the pointer: the middle frame stays in the middle.
    expect((first + last) / 2).toBeCloseTo(LEN / 2, -1);
  });

  it("zooming in at the left edge keeps frame 0 in place", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -100, clientX: 0 });
    expect(firstVisibleFrame(wrap)).toBe(0);
    expect(lastVisibleFrame(wrap)).toBeLessThan(LEN / 2);
  });

  it("shift+wheel pans a zoomed view and stops at the sample's end", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -100, clientX: 0 });
    const span = lastVisibleFrame(wrap) - firstVisibleFrame(wrap);
    fireEvent.wheel(wrap, { deltaY: 200, shiftKey: true });
    const panned = firstVisibleFrame(wrap);
    expect(panned).toBeGreaterThan(0);
    expect(lastVisibleFrame(wrap) - panned).toBe(span);
    fireEvent.wheel(wrap, { deltaY: 1e6, shiftKey: true });
    expect(lastVisibleFrame(wrap)).toBe(LEN);
    expect(firstVisibleFrame(wrap)).toBe(LEN - span);
  });

  it("wheel down zooms back out, never past the whole sample", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -100, clientX: W / 2 });
    fireEvent.wheel(wrap, { deltaY: 1000, clientX: W / 2 });
    expect(firstVisibleFrame(wrap)).toBe(0);
    expect(lastVisibleFrame(wrap)).toBe(LEN);
  });

  it("double-click resets the zoom", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -300, clientX: W / 2 });
    expect(firstVisibleFrame(wrap)).toBeGreaterThan(0);
    fireEvent.dblClick(wrap, { clientX: W / 2 });
    expect(firstVisibleFrame(wrap)).toBe(0);
    expect(lastVisibleFrame(wrap)).toBe(LEN);
  });

  it("keeps the zoom when an edit leaves the sample data alone", () => {
    const wrap = mount();
    fireEvent.wheel(wrap, { deltaY: -100, clientX: W / 2 });
    const first = firstVisibleFrame(wrap);
    patchXmSample(1, { volume: 32 }, 0);
    expect(firstVisibleFrame(wrap)).toBe(first);
  });
});

describe("PT waveform zoom", () => {
  function mount(): Element {
    const s = emptySong();
    s.samples[0] = {
      ...s.samples[0]!,
      name: "demo",
      volume: 64,
      lengthWords: LEN >> 1,
      data: new Int8Array(LEN),
    };
    setSong(s);
    setView("sample");
    const { container } = render(() => <App />);
    const wf = container.querySelector(".waveform")!;
    stubRect(wf);
    return wf;
  }

  const visibleRange = (wf: Element): [number, number] => {
    let first = -1;
    let last = -1;
    pressAt(wf, 0, () => (first = sampleSelection()!.start));
    pressAt(wf, W, () => (last = sampleSelection()!.start));
    return [first, last];
  };

  it("zooms around the pointer, pans, and resets on double-click", () => {
    const wf = mount();
    expect(visibleRange(wf)).toEqual([0, LEN]);

    fireEvent.wheel(wf, { deltaY: -100, clientX: W / 2 });
    const [first, last] = visibleRange(wf);
    expect(last - first).toBeLessThan(LEN / 2);
    expect((first + last) / 2).toBeCloseTo(LEN / 2, -1);

    fireEvent.wheel(wf, { deltaY: 100, shiftKey: true });
    const [pannedFirst, pannedLast] = visibleRange(wf);
    expect(pannedFirst).toBeGreaterThan(first);
    expect(pannedLast - pannedFirst).toBe(last - first);

    fireEvent.dblClick(wf, { clientX: W / 2 });
    expect(visibleRange(wf)).toEqual([0, LEN]);
  });
});
