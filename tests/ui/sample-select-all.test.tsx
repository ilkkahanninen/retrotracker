import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
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
import {
  sampleSelection,
  setSampleSelection,
} from "../../src/state/sampleSelection";
import {
  clearAllWorkbenches,
  setWorkbench,
} from "../../src/state/sampleWorkbench";
import { workbenchFromChiptune } from "../../src/core/audio/sampleWorkbench";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
  setSampleSelection(null);
  clearAllWorkbenches();
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Stamp 200 bytes of int8 data into slot 0 so the selection has a real range. */
function seedSampleData(): void {
  const s = song()!;
  setSong({
    ...s,
    samples: s.samples.map((sm, i) =>
      i === 0
        ? {
            ...sm,
            name: "demo",
            volume: 64,
            lengthWords: 100,
            data: new Int8Array(200),
          }
        : sm,
    ),
  });
}

describe("SampleView: Select all", () => {
  it("the button selects the whole int8 byte range", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    ].find((b) => b.textContent === "Select all")!;
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(sampleSelection()).toEqual({ start: 0, end: 200 });
  });

  it("the button is disabled when the slot has no data", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Slot 1 is empty by default (data.length === 0).
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    ].find((b) => b.textContent === "Select all")!;
    expect(button.disabled).toBe(true);
  });

  it("Cmd+A selects the whole int8 byte range while in sample view", async () => {
    setView("sample");
    render(() => <App />);
    seedSampleData();
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(sampleSelection()).toEqual({ start: 0, end: 200 });
  });

  it("Cmd+A does NOT select waveform while in pattern view", async () => {
    // Cmd+A in pattern view is the channel/pattern range expander; the
    // sample-side handler is gated `view() === 'sample'` so it must not fire.
    setView("pattern");
    render(() => <App />);
    seedSampleData();
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(sampleSelection()).toBeNull();
  });

  it("Cmd+A is a no-op when the slot's source is chiptune", async () => {
    // Chiptune sources don't expose selection — the synth re-renders the
    // cycle on every param change, so any range would be wiped immediately,
    // and the SampleView hides the selection-action row anyway. Cmd+A
    // mirrors that gate so it can't leave a stale selection sitting around.
    setView("sample");
    render(() => <App />);
    seedSampleData();
    setWorkbench(0, workbenchFromChiptune());
    const user = userEvent.setup();
    await user.keyboard("{Meta>}a{/Meta}");
    expect(sampleSelection()).toBeNull();
  });

  it("the Select-all button is hidden when the source is chiptune", () => {
    // The whole selection-action row (Crop / Cut / Select all / effect
    // buttons) is hidden in chiptune mode — the synth re-renders on every
    // param edit so any range would be wiped, and there's no destructive
    // op the row would dispatch to.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    setWorkbench(0, workbenchFromChiptune());
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    ].find((b) => b.textContent === "Select all");
    expect(button).toBeUndefined();
  });
});
