import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  clearHistory,
  song,
} from "../../src/state/song";
import { setCurrentSample, setCurrentOctave } from "../../src/state/edit";
import { setView } from "../../src/state/view";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/**
 * Stamp a sample with `dataLen` bytes into slot 0 so the waveform has
 * non-trivial range and the byte-under-pointer math has room to vary.
 */
function seedSampleData(dataLen: number): void {
  const s = song()!;
  setSong({
    ...s,
    samples: s.samples.map((sm, i) =>
      i === 0
        ? {
            ...sm,
            name: "demo",
            volume: 64,
            lengthWords: dataLen >> 1,
            data: new Int8Array(dataLen),
          }
        : sm,
    ),
  });
}

/**
 * Pin getBoundingClientRect on the waveform so clientToCanvasX → x is the
 * identity (rect.width=1024 matches the canvas-internal W=1024). With
 * sample length 4000 and W=1024, dataLen > W: byteForX(x) = round(x*4000/1024).
 */
function stubWaveformRect(wf: Element): void {
  wf.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 1024,
      height: 160,
      right: 1024,
      bottom: 160,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("Waveform: cursor info tooltip", () => {
  it("hovering shows the frame number and the equivalent 9xx parameter", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData(4000);
    const wf = container.querySelector(".waveform")!;
    stubWaveformRect(wf);

    // Before any move, the tooltip is absent.
    expect(container.querySelector(".waveform__cursor-info")).toBeNull();

    // clientX=500 → x=500 → byteForX = round(500 * 4000 / 1024) = 1953.
    // 9xx = 9 + (1953 >> 8 = 7) → "907".
    fireEvent.mouseMove(wf, { clientX: 500, clientY: 80 });

    const info = container.querySelector(".waveform__cursor-info")!;
    expect(info).toBeTruthy();
    expect(info.textContent).toContain("Frame: 1953");
    expect(info.textContent).toContain("907");
  });

  it("clears the tooltip on mouseleave", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData(4000);
    const wf = container.querySelector(".waveform")!;
    stubWaveformRect(wf);

    fireEvent.mouseMove(wf, { clientX: 500, clientY: 80 });
    expect(container.querySelector(".waveform__cursor-info")).toBeTruthy();
    fireEvent.mouseLeave(wf);
    expect(container.querySelector(".waveform__cursor-info")).toBeNull();
  });

  it("the tooltip stays hidden when the slot is empty", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Slot 1 is empty by default — data.length === 0.
    const wf = container.querySelector(".waveform")!;
    stubWaveformRect(wf);
    fireEvent.mouseMove(wf, { clientX: 500, clientY: 80 });
    expect(container.querySelector(".waveform__cursor-info")).toBeNull();
  });

  it("9xx saturates at 9FF for samples past 65280 bytes", () => {
    // PT's SetSampleOffset param is 8-bit, multiplied by 256 → max byte
    // address is 65280. Anything past that should still render as "9FF"
    // (closest reachable byte) rather than overflowing.
    setView("sample");
    const { container } = render(() => <App />);
    // 100000-byte sample → frames past 65280 are reachable on the waveform.
    seedSampleData(100000);
    const wf = container.querySelector(".waveform")!;
    stubWaveformRect(wf);
    // clientX=900 → x=900 → byteForX = round(900*100000/1024) = 87891. >> 8 = 343 → cap 0xFF.
    fireEvent.mouseMove(wf, { clientX: 900, clientY: 80 });
    const info = container.querySelector(".waveform__cursor-info")!;
    expect(info.textContent).toContain("9FF");
  });
});
