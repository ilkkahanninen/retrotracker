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
  setCurrentXmInstrument,
  setCurrentXmSampleIndex,
} from "../../src/state/xmEdit";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.name = "sa";
  // 100 frames of int8 data so loop fields have room to move.
  inst.samples[0]!.data = new Int8Array(100);
  inst.samples[0]!.bits = 8;
  inst.samples[0]!.loopType = "forward";
  inst.samples[0]!.loopStart = 20;
  inst.samples[0]!.loopLength = 40;
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

/** Map a frame index to an x-client coord assuming the wrapper occupies
 *  CSS width 1000 (matches the mocked rect below). */
function clientXForFrame(frame: number, len = 100, width = 1000): number {
  return Math.round((frame / len) * width);
}

function mockRect(el: Element, width = 1000, height = 90): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("XmWaveform: draggable loop markers", () => {
  it("dragging the loop-start handle updates loopStart", () => {
    const { container } = mountView();
    const wrap = container.querySelector(".xm-waveform-wrap") as HTMLElement;
    mockRect(wrap);
    // Grab the loop-start handle (loopStart = 20 → clientX ≈ 200).
    fireEvent.mouseDown(wrap, { clientX: clientXForFrame(20) });
    // Drag to frame 30 → clientX ≈ 300.
    fireEvent.mouseMove(wrap, { clientX: clientXForFrame(30) });
    fireEvent.mouseUp(window);
    const sample = xm2Song()!.instruments[0]!.samples[0]!;
    expect(sample.loopStart).toBeGreaterThanOrEqual(28);
    expect(sample.loopStart).toBeLessThanOrEqual(32);
    // The end frame stays put (loopStart + loopLength stays at 60).
    expect(sample.loopStart + sample.loopLength).toBe(60);
  });

  it("dragging the loop-end handle updates loopLength", () => {
    const { container } = mountView();
    const wrap = container.querySelector(".xm-waveform-wrap") as HTMLElement;
    mockRect(wrap);
    // Grab the loop-end handle (loopStart + loopLength = 60).
    fireEvent.mouseDown(wrap, { clientX: clientXForFrame(60) });
    // Drag right to frame 80.
    fireEvent.mouseMove(wrap, { clientX: clientXForFrame(80) });
    fireEvent.mouseUp(window);
    const sample = xm2Song()!.instruments[0]!.samples[0]!;
    expect(sample.loopStart).toBe(20);
    // loopLength = endFrame(80) - loopStart(20) → ~60 (allowing rounding).
    expect(sample.loopLength).toBeGreaterThanOrEqual(58);
    expect(sample.loopLength).toBeLessThanOrEqual(62);
  });

  it("loop handles are inert when loopType === 'none' (drag starts a selection instead)", () => {
    const s = xm2Song()!;
    s.instruments[0]!.samples[0]!.loopType = "none";
    s.instruments[0]!.samples[0]!.loopLength = 0;
    setSong({ ...s });
    const { container } = mountView();
    const wrap = container.querySelector(".xm-waveform-wrap") as HTMLElement;
    mockRect(wrap);
    // Click where the loop-start handle WOULD have been — should
    // initiate a selection drag, not patch the loop.
    fireEvent.mouseDown(wrap, { clientX: clientXForFrame(20) });
    fireEvent.mouseMove(wrap, { clientX: clientXForFrame(40) });
    fireEvent.mouseUp(window);
    const sample = xm2Song()!.instruments[0]!.samples[0]!;
    // Loop fields untouched.
    expect(sample.loopLength).toBe(0);
    expect(sample.loopType).toBe("none");
  });
});
