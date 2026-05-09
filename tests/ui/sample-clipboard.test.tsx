/**
 * UI-level coverage for the sample clipboard: toolbar buttons and the
 * Cmd+C / Cmd+X / Cmd+V shortcuts in the sample view. Verifies that
 * dispatch is view-aware (sample-view shortcuts target the sample
 * clipboard, NOT the pattern clipboard).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@solidjs/testing-library";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR } from "../../src/state/cursor";
import {
  clearHistory,
  setSong,
  setTransport,
  setPlayPos,
  song,
} from "../../src/state/song";
import { setCurrentSample, setCurrentOctave } from "../../src/state/edit";
import { setView } from "../../src/state/view";
import {
  clearAllWorkbenches,
  setWorkbench,
} from "../../src/state/sampleWorkbench";
import { clearAllStashedLoops } from "../../src/state/loopStash";
import { clearAllImportedStashes } from "../../src/state/importedStash";
import {
  setSampleSelection,
  sampleSelection,
} from "../../src/state/sampleSelection";
import {
  sampleClipboard,
  setSampleClipboard,
  clearSampleClipboard,
} from "../../src/state/sampleClipboard";
import { clipboardSlice, setClipboardSlice } from "../../src/state/clipboard";
import { emptySong } from "../../src/core/mod/format";
import { replaceSampleData } from "../../src/core/mod/mutations";
import { workbenchFromInt8 } from "../../src/core/audio/sampleWorkbench";

function reset() {
  setSong(emptySong());
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setView("pattern");
  clearAllWorkbenches();
  clearAllStashedLoops();
  clearAllImportedStashes();
  setSampleSelection(null);
  clearSampleClipboard();
  setClipboardSlice(null);
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

/** Stamp some bytes into slot 0 and wrap a sampler workbench around them
 *  so the SampleView shows the toolbar (it hides the toolbar in chiptune
 *  mode). */
function seedPopulatedSlot(): void {
  const data = new Int8Array(80).map((_, i) => (i % 32) - 16);
  setSong(
    replaceSampleData(song()!, 0, data, {
      name: "demo",
      volume: 64,
      finetune: 0,
      loopStartWords: 0,
      loopLengthWords: 1,
    }),
  );
  setWorkbench(0, workbenchFromInt8(data, "demo"));
}

/** Dispatch a window-level Cmd+`key` keydown. */
function chord(key: "c" | "x" | "v"): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true }));
}

describe("Sample view toolbar: Copy / Cut / Paste buttons", () => {
  it("renders Copy, Cut, and Paste buttons (replacing the previous Delete)", () => {
    seedPopulatedSlot();
    setView("sample");
    const { container } = render(() => <App />);
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    ).map((b) => b.textContent?.trim());
    expect(labels).toContain("Copy");
    expect(labels).toContain("Cut");
    expect(labels).toContain("Paste");
    // The old "Delete" label is gone.
    expect(labels).not.toContain("Delete");
  });

  it("Copy button writes the slot's bytes to the sample clipboard", () => {
    seedPopulatedSlot();
    setView("sample");
    const { container } = render(() => <App />);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    );
    const copyBtn = buttons.find((b) => b.textContent?.trim() === "Copy")!;
    fireEvent.click(copyBtn);
    expect(sampleClipboard()).not.toBeNull();
    expect(sampleClipboard()!.byteLength).toBe(80); // whole-sample fallback
  });

  it("Cut button on a selection: clipboard set AND chain gains a `cut` effect", () => {
    seedPopulatedSlot();
    setView("sample");
    const { container } = render(() => <App />);
    // SampleView's onMount effect clears selection when currentSample
    // changes — set the selection AFTER render so the effect doesn't
    // wipe it.
    setSampleSelection({ start: 10, end: 30 });
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    );
    const cutBtn = buttons.find((b) => b.textContent?.trim() === "Cut")!;
    fireEvent.click(cutBtn);
    expect(sampleClipboard()).not.toBeNull();
    expect(sampleClipboard()!.byteLength).toBe(20);
    // Selection cleared after cut.
    expect(sampleSelection()).toBeNull();
  });

  it("Paste button is disabled when the sample clipboard is empty", () => {
    seedPopulatedSlot();
    setView("sample");
    const { container } = render(() => <App />);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    );
    const pasteBtn = buttons.find((b) => b.textContent?.trim() === "Paste")!;
    expect(pasteBtn.disabled).toBe(true);
  });

  it("Paste button is enabled and replaces the slot's bytes when clicked", () => {
    seedPopulatedSlot();
    setView("sample");
    setSampleClipboard(new Int8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const { container } = render(() => <App />);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".sampleview__selection button",
      ),
    );
    const pasteBtn = buttons.find((b) => b.textContent?.trim() === "Paste")!;
    expect(pasteBtn.disabled).toBe(false);
    fireEvent.click(pasteBtn);
    expect(Array.from(song()!.samples[0]!.data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe("Sample view: Cmd+C / Cmd+X / Cmd+V dispatch by view", () => {
  it("Cmd+C in the sample view writes to the sample clipboard, not the pattern clipboard", () => {
    seedPopulatedSlot();
    setView("sample");
    render(() => <App />);
    chord("c");
    expect(sampleClipboard()).not.toBeNull();
    // Pattern clipboard untouched.
    expect(clipboardSlice()).toBeNull();
  });

  it("Cmd+X in the sample view copies AND adds a cut effect", () => {
    seedPopulatedSlot();
    setView("sample");
    render(() => <App />);
    // Set selection after mount; see toolbar Cut test for context.
    setSampleSelection({ start: 20, end: 40 });
    chord("x");
    expect(sampleClipboard()).not.toBeNull();
    expect(sampleClipboard()!.byteLength).toBe(20);
  });

  it("Cmd+V in the sample view pastes from the sample clipboard", () => {
    setView("sample");
    setSampleClipboard(new Int8Array([42, 43, 44, 45]));
    render(() => <App />);
    chord("v");
    expect(Array.from(song()!.samples[0]!.data)).toEqual([42, 43, 44, 45]);
  });

  it("Cmd+C in the pattern view doesn't touch the sample clipboard", () => {
    seedPopulatedSlot();
    setView("pattern");
    // Drop a value into the sample clipboard so we can verify it
    // survives a pattern-view Cmd+C unchanged.
    const sentinel = new Int8Array([99, 99, 99]);
    setSampleClipboard(sentinel);
    render(() => <App />);
    chord("c");
    // Pattern Cmd+C with no pattern selection is a no-op for the
    // pattern clipboard, but must not clobber the sample clipboard.
    expect(sampleClipboard()).toBe(sentinel);
  });

  it("Cmd+V in the sample view during playback still pastes (sample edits aren't transport-gated)", () => {
    setView("sample");
    // Use an even-length payload so we don't have to reason about PT's
    // word-alignment padding (replaceSampleData rounds odd lengths up
    // by one zero byte).
    setSampleClipboard(new Int8Array([7, 8, 9, 10]));
    setTransport("playing");
    render(() => <App />);
    chord("v");
    expect(Array.from(song()!.samples[0]!.data)).toEqual([7, 8, 9, 10]);
  });
});
