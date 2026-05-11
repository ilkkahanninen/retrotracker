import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptyXmSong } from "../../src/core/xm/format";
import { resetXmCursor, setXmCursor, xmCursor } from "../../src/state/cursorXm";
import { clearXmSelection } from "../../src/state/selection";
import {
  clearHistory,
  setPlayPos,
  setSong,
  setTransport,
  xm2Song,
} from "../../src/state/song";
import {
  setCurrentXmInstrument,
  setCurrentXmOctave,
} from "../../src/state/xmEdit";
import { setEditStep } from "../../src/state/edit";

function resetFt2Session() {
  setSong(emptyXmSong());
  resetXmCursor();
  clearXmSelection();
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCurrentXmOctave(4);
  setCurrentXmInstrument(1);
  setEditStep(1);
}

beforeEach(resetFt2Session);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

function noteAt(row: number, channel: number): number {
  return xm2Song()!.patterns[0]!.rows[row]![channel]!.note;
}

function seedNoteAt(row: number, channel: number, note: number): void {
  xm2Song()!.patterns[0]!.rows[row]![channel]!.note = note;
}

describe("FT2 backspace (pull-up)", () => {
  it("Backspace pulls the channel up by one, leaves other channels alone", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 40);
    seedNoteAt(1, 0, 41);
    seedNoteAt(2, 0, 42);
    seedNoteAt(2, 1, 50); // channel 1 marker
    setXmCursor({ ...xmCursor(), row: 2 });
    const user = userEvent.setup();
    await user.keyboard("{Backspace}");
    expect(noteAt(0, 0)).toBe(40);
    expect(noteAt(1, 0)).toBe(42); // shifted up
    expect(noteAt(1, 1)).toBe(0); // channel 1 untouched
    expect(noteAt(2, 1)).toBe(50); // channel 1 untouched
  });

  it("Shift+Backspace pulls the entire row up across all channels", async () => {
    render(() => <App />);
    seedNoteAt(1, 0, 41);
    seedNoteAt(1, 1, 51);
    seedNoteAt(2, 0, 42);
    seedNoteAt(2, 1, 52);
    setXmCursor({ ...xmCursor(), row: 2 });
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{Backspace}{/Shift}");
    expect(noteAt(1, 0)).toBe(42);
    expect(noteAt(1, 1)).toBe(52);
  });
});

describe("FT2 insert (push-down)", () => {
  it("Enter pushes the cursor's channel down by one row", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 40);
    seedNoteAt(0, 1, 50);
    setXmCursor({ ...xmCursor(), row: 0, channel: 0, field: "note" });
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(noteAt(0, 0)).toBe(0); // pushed down
    expect(noteAt(1, 0)).toBe(40);
    expect(noteAt(0, 1)).toBe(50); // other channel untouched
  });

  it("Shift+Enter pushes the entire row down across all channels", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 40);
    seedNoteAt(0, 1, 50);
    setXmCursor({ ...xmCursor(), row: 0 });
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(noteAt(0, 0)).toBe(0);
    expect(noteAt(0, 1)).toBe(0);
    expect(noteAt(1, 0)).toBe(40);
    expect(noteAt(1, 1)).toBe(50);
  });
});
