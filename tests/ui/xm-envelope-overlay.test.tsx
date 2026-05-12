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
import {
  addXmEffect,
  setXmSelectedEffectIndex,
  setXmSelectedEffectParam,
} from "../../src/state/xmSampleEdit";
import {
  clearAllXmWorkbenches,
  getXmWorkbench,
} from "../../src/state/xmSampleWorkbench";

function seed(): void {
  const s = emptyXmSong();
  const inst = emptyXmInstrument();
  inst.name = "ins-a";
  inst.samples[0]!.name = "sa";
  inst.samples[0]!.data = new Int8Array(100);
  inst.samples[0]!.bits = 8;
  s.instruments = [inst];
  setSong(s);
  setCurrentXmInstrument(1);
  setCurrentXmSampleIndex(0);
  setTransport("idle");
  clearAllXmWorkbenches();
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  clearHistory();
}

beforeEach(seed);
afterEach(() => {
  cleanup();
  setSong(null);
  setXmSelectedEffectIndex(null);
  setXmSelectedEffectParam(null);
  clearHistory();
});

function mountView() {
  const song = () => xm2Song()!;
  return render(() => <InstrumentView song={song()} />);
}

function mockRect(el: Element, width = 1024, height = 90): void {
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

describe("XmWaveform: envelope overlay", () => {
  it("does not render the overlay when no effect is selected", () => {
    const { container } = mountView();
    const overlay = container.querySelector(".waveform__envelope");
    expect(overlay).toBeNull();
  });

  it("renders the overlay when a volume effect is selected", () => {
    const view = mountView();
    addXmEffect("volume");
    // addXmEffect auto-selects the new index + param. Verify the SVG
    // overlay appears.
    const overlay = view.container.querySelector(".waveform__envelope");
    expect(overlay).not.toBeNull();
    // Default volume envelope has 2 points → 2 circles in the SVG.
    const circles = overlay!.querySelectorAll("circle.envelope__point");
    expect(circles.length).toBe(2);
  });

  it("double-click on the overlay adds a new envelope point", () => {
    const view = mountView();
    addXmEffect("volume");
    const wrap = view.container.querySelector(
      ".xm-waveform-wrap",
    ) as HTMLElement;
    mockRect(wrap);
    const overlay = view.container.querySelector(
      ".waveform__envelope",
    ) as SVGElement;
    expect(overlay).not.toBeNull();
    mockRect(overlay);
    // Double-click ~midway across the wrap, vertically near the top
    // (high gain).
    fireEvent.dblClick(overlay, { clientX: 512, clientY: 20 });
    // Workbench chain entry's `volume` envelope now has at least 3 points.
    const wb = getXmWorkbench(1, 0);
    expect(wb).not.toBeNull();
    const node = wb!.chain[0]!;
    expect(node.kind).toBe("volume");
    if (node.kind !== "volume") return;
    expect(node.params.points.length).toBeGreaterThanOrEqual(3);
  });

  it("overlay disappears when the selection is cleared", () => {
    const view = mountView();
    addXmEffect("volume");
    expect(view.container.querySelector(".waveform__envelope")).not.toBeNull();
    setXmSelectedEffectIndex(null);
    setXmSelectedEffectParam(null);
    expect(view.container.querySelector(".waveform__envelope")).toBeNull();
  });
});
