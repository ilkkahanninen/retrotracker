import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
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
  clearXmSampleSelection,
  setXmSampleSelection,
  xmSampleSelection,
} from "../../src/state/xmSampleSelection";
import { clearAllXmWorkbenches } from "../../src/state/xmSampleWorkbench";
import { setView } from "../../src/state/view";

function seedSong(): void {
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
  setView("sample");
  clearXmSampleSelection();
  clearAllXmWorkbenches();
  clearHistory();
}

beforeEach(seedSong);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
  setView("pattern");
});

describe("XM waveform selection + clipboard buttons", () => {
  it("Cmd+A selects the whole XM sample in sample view", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(xmSampleSelection()).toEqual({ start: 0, end: 8 });
  });

  it("Cmd+C copies the active selection range", async () => {
    render(() => <App />);
    setXmSampleSelection({ start: 2, end: 5 });
    const user = userEvent.setup();
    await user.keyboard("{Meta>}c{/Meta}");
    // After copy the selection is still in place. Verify the clipboard
    // received [3, 4, 5] (frames 2..4).
    const { xmSampleClipboard } =
      await import("../../src/state/xmSampleClipboard");
    expect(Array.from(xmSampleClipboard()!.data)).toEqual([3, 4, 5]);
  });

  it("Crop button trims the buffer to the selection and clears the selection", async () => {
    const view = render(() => <App />);
    setXmSampleSelection({ start: 2, end: 6 });
    const cropBtn = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    ).find((b) => b.textContent?.includes("Crop"));
    expect(cropBtn).toBeDefined();
    fireEvent.click(cropBtn!);
    expect(Array.from(xm2Song()!.instruments[0]!.samples[0]!.data)).toEqual([
      3, 4, 5, 6,
    ]);
    expect(xmSampleSelection()).toBeNull();
  });
});
