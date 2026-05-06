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
import { clearAllStashedLoops } from "../../src/state/loopStash";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
  clearAllStashedLoops();
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Stamp some bytes into slot 0 so loop editing has a non-zero target. */
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
            loopStartWords: 0,
            loopLengthWords: 1,
            data: new Int8Array(200),
          }
        : sm,
    ),
  });
}

describe("SampleView: loop toggle", () => {
  it("checking the toggle enables looping over the whole sample", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    expect(toggle.checked).toBe(false);
    fireEvent.change(toggle, { target: { checked: true } });
    expect(song()!.samples[0]!.loopStartWords).toBe(0);
    expect(song()!.samples[0]!.loopLengthWords).toBe(100); // whole sample
  });

  it("unchecking the toggle restores the PT no-loop sentinel (loopLengthWords=1)", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    setSong({
      ...song()!,
      samples: song()!.samples.map((sm, i) =>
        i === 0 ? { ...sm, loopStartWords: 10, loopLengthWords: 50 } : sm,
      ),
    });
    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    expect(toggle.checked).toBe(true);
    fireEvent.change(toggle, { target: { checked: false } });
    expect(song()!.samples[0]!.loopLengthWords).toBe(1);
    // loopStart preserved so toggling back on retains intent.
    expect(song()!.samples[0]!.loopStartWords).toBe(10);
  });

  it("enabling loop with a selection adopts the selection as the loop range and clears it", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData(); // 200 bytes / lengthWords=100

    // Mock the .waveform getBoundingClientRect so clientToCanvasX has a
    // non-zero rect to scale against. (jsdom returns 0×0 by default.)
    const wf = container.querySelector(".waveform") as HTMLElement;
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

    // Drag a selection. With dataLen=200 ≤ canvas-internal W=1024 we're in
    // line mode: byteForX(x) = round(x / 1023 * 199).
    //   clientX=205  → byte 40
    //   clientX=820  → byte 160
    fireEvent.mouseDown(wf, { clientX: 205 });
    fireEvent.mouseMove(wf, { clientX: 820 });

    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    fireEvent.change(toggle, { target: { checked: true } });

    // Word-aligned: start=40 stays 40, end=160 stays 160.
    // loopStartWords = 20, loopLengthWords = 60.
    expect(song()!.samples[0]!.loopStartWords).toBe(20);
    expect(song()!.samples[0]!.loopLengthWords).toBe(60);
    // The selection is dropped — the loop handles take over the role.
    expect(container.querySelector(".sampleview__selection-info")).toBeNull();
  });

  it("falls back to whole-sample loop when there is no selection", () => {
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    fireEvent.change(toggle, { target: { checked: true } });
    expect(song()!.samples[0]!.loopStartWords).toBe(0);
    expect(song()!.samples[0]!.loopLengthWords).toBe(100);
  });

  it("the toggle is visually disabled during playback so the user knows to stop first", () => {
    // Regression: previously the toggle stayed enabled during playback.
    // Clicking it briefly flickered the checkbox checked before Solid
    // reactively reverted it (because commitEdit silently rejects edits
    // with transport === 'playing'). The user thought the loop was
    // configured but the song never received it — exactly the "loop
    // works in preview but not in song play" report. Now the toggle is
    // disabled during playback, making the constraint visible.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    setTransport("playing");

    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    expect(toggle.disabled).toBe(true);
  });

  it("toggle is disabled when the slot is empty", () => {
    setView("sample");
    const { container } = render(() => <App />);
    // Slot 1 is empty by default (lengthWords=0).
    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    expect(toggle.disabled).toBe(true);
  });

  it("re-enabling restores the loop bounds the user had before disabling", () => {
    // User flow: enable → drag handles to a non-default range → disable →
    // re-enable. Without the loop-stash, the second enable would default to
    // "loop the whole sample" and silently lose the previous range.
    setView("sample");
    const { container } = render(() => <App />);
    seedSampleData();
    // Set a non-default loop directly on the song to mimic the user having
    // dragged the handles into place — bypasses the click/drag plumbing the
    // selection-based test already covers.
    const s0 = song()!;
    setSong({
      ...s0,
      samples: s0.samples.map((sm, i) =>
        i === 0 ? { ...sm, loopStartWords: 25, loopLengthWords: 40 } : sm,
      ),
    });

    const toggle = container.querySelector<HTMLInputElement>(
      '.samplemeta__check input[type="checkbox"]',
    )!;
    // Disable: the bounds get stashed and the song's loopLengthWords goes to 1.
    fireEvent.change(toggle, { target: { checked: false } });
    expect(song()!.samples[0]!.loopLengthWords).toBe(1);
    // Re-enable: stashed bounds are restored, NOT "whole sample" (length=100).
    fireEvent.change(toggle, { target: { checked: true } });
    expect(song()!.samples[0]!.loopStartWords).toBe(25);
    expect(song()!.samples[0]!.loopLengthWords).toBe(40);
  });
});
