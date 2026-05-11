import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptyXmSong } from "../../src/core/xm/format";
import { resetXmCursor, setXmCursor, xmCursor } from "../../src/state/cursorXm";
import { setXmSelection, clearXmSelection } from "../../src/state/selection";
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

function seedNoteAt(row: number, channel: number, note: number): void {
  const s = xm2Song()!;
  s.patterns[0]!.rows[row]![channel]!.note = note;
}

beforeEach(resetFt2Session);
afterEach(() => {
  cleanup();
  setSong(null);
  clearHistory();
});

describe("FT2 transpose", () => {
  it("Shift+= transposes the cursor cell up one semitone", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 49); // C-4
    const user = userEvent.setup();
    await user.keyboard("{Shift>}={/Shift}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(50);
  });

  it("Shift+- transposes down one semitone", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 49);
    const user = userEvent.setup();
    await user.keyboard("{Shift>}-{/Shift}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(48);
  });

  it("Mod+Shift+= transposes by one octave", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 49);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}{Shift>}={/Shift}{/Meta}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(61);
  });

  it("clamps at the bottom edge (note 1)", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 2);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}{Shift>}-{/Shift}{/Meta}"); // -12
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(1);
  });

  it("clamps at the top edge (note 96)", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 95);
    const user = userEvent.setup();
    await user.keyboard("{Meta>}{Shift>}={/Shift}{/Meta}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(96);
  });

  it("leaves key-off (97) untouched", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 97);
    const user = userEvent.setup();
    await user.keyboard("{Shift>}={/Shift}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(97);
  });

  it("leaves empty cells empty", async () => {
    render(() => <App />);
    // row 0 ch 0 stays note=0
    const user = userEvent.setup();
    await user.keyboard("{Shift>}={/Shift}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(0);
  });

  it("operates on the whole selection when one is active", async () => {
    render(() => <App />);
    seedNoteAt(0, 0, 49);
    seedNoteAt(1, 0, 50);
    seedNoteAt(2, 0, 51);
    setXmCursor({ ...xmCursor(), order: 0, row: 0, channel: 0 });
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 2,
      startChannel: 0,
      endChannel: 0,
    });
    const user = userEvent.setup();
    await user.keyboard("{Shift>}={/Shift}");
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(50);
    expect(xm2Song()!.patterns[0]!.rows[1]![0]!.note).toBe(51);
    expect(xm2Song()!.patterns[0]!.rows[2]![0]!.note).toBe(52);
  });
});
