import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { App } from "../../src/App";
import { emptyXmSong } from "../../src/core/xm/format";
import { resetXmCursor, xmCursor } from "../../src/state/cursorXm";
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

/**
 * Sanity tests for FT2-mode keyboard wiring. We mount the full App
 * (so the keybind registration runs), seed a fresh `XmSong`, and dispatch
 * keyboard events with `userEvent`. The PT keybind set must NOT fire here
 * — `appKeybinds.ts` gates every PT-specific shortcut on `isPt2Mode`.
 */
function resetFt2Session() {
  setSong(emptyXmSong());
  resetXmCursor();
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

describe("FT2 keyboard: cursor navigation", () => {
  it("ArrowRight walks through XM_FIELDS in order", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    const expected = [
      "instHi",
      "instLo",
      "volHi",
      "volLo",
      "effectCmd",
      "effectHi",
      "effectLo",
    ];
    for (const f of expected) {
      await user.keyboard("{ArrowRight}");
      expect(xmCursor().field).toBe(f);
    }
    // One more wraps to channel 1, note.
    await user.keyboard("{ArrowRight}");
    expect(xmCursor()).toMatchObject({ channel: 1, field: "note" });
  });

  it("ArrowDown advances the row", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(xmCursor().row).toBe(1);
  });
});

describe("FT2 keyboard: note entry", () => {
  it("typing 'a' on the note field writes a C in the current octave", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCurrentXmOctave(4);
    await user.keyboard("a");
    const cell = xm2Song()!.patterns[0]!.rows[0]![0]!;
    expect(cell.note).toBe(49); // 4*12 + 0 + 1
  });
});

describe("FT2 keyboard: hex digit + effect letter entry", () => {
  it("on instHi typing '5' writes 0x50 to the instrument byte", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}"); // → instHi
    await user.keyboard("5");
    const cell = xm2Song()!.patterns[0]!.rows[0]![0]!;
    expect(cell.instrument).toBe(0x50);
    expect(xmCursor().field).toBe("instLo");
  });

  it("on effectCmd typing 'g' writes effect 0x10 (XM global vol)", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    // Step right to effectCmd.
    for (let i = 0; i < 5; i++) await user.keyboard("{ArrowRight}");
    expect(xmCursor().field).toBe("effectCmd");
    await user.keyboard("g");
    const cell = xm2Song()!.patterns[0]!.rows[0]![0]!;
    expect(cell.effect).toBe(0x10);
    expect(xmCursor().field).toBe("effectHi");
  });
});
