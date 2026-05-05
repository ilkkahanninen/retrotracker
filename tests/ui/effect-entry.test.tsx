import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import { setCursor, INITIAL_CURSOR, cursor } from "../../src/state/cursor";
import {
  setSong,
  setTransport,
  setPlayPos,
  clearHistory,
  song,
} from "../../src/state/song";
import {
  setCurrentSample,
  setCurrentOctave,
  setEditStep,
  editStep,
} from "../../src/state/edit";

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport("idle");
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
}

beforeEach(resetState);
afterEach(() => {
  cleanup();
  resetState();
});

/** Read the cell at (order=0, row, channel=0). */
function cellAt(row: number) {
  const s = song();
  if (!s) throw new Error("no song mounted");
  const patNum = s.orders[0]!;
  return s.patterns[patNum]!.rows[row]![0]!;
}

/** Move the cursor onto the named field of (order=0, row=0, channel=0). */
function placeCursor(field: ReturnType<typeof cursor>["field"]) {
  setCursor({ order: 0, row: 0, channel: 0, field });
}

/** Move the cursor onto a specific (row, field, channel) of order 0. */
function setCursorAtRow(
  row: number,
  field: ReturnType<typeof cursor>["field"],
  channel = 0,
) {
  setCursor({ order: 0, row, channel, field });
}

describe("effect entry: single-nibble writes", () => {
  it("digit on effectCmd sets the command and advances to effectHi", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c"); // 0xC = SetVolume
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0);
    expect(cursor()).toMatchObject({ row: 0, field: "effectHi" });
  });

  it("digit on effectHi sets the high nibble and advances to effectLo", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectHi");
    await user.keyboard("4");
    expect(cellAt(0).effectParam).toBe(0x40);
    expect(cursor().field).toBe("effectLo");
  });

  it("digit on effectLo sets the low nibble, advances down, and rewinds to effectCmd", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectLo");
    await user.keyboard("a");
    expect(cellAt(0).effectParam).toBe(0x0a);
    // Field rewinds to effectCmd on the new row so the user can type the
    // next 3-digit effect without moving the cursor back manually.
    expect(cursor()).toMatchObject({ row: 1, channel: 0, field: "effectCmd" });
  });
});

describe('effect entry: three-digit chord "C40" (set-volume 64)', () => {
  it("typing c, 4, 0 in sequence yields effect=0xC, param=0x40", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40");
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0x40);
    // cmd → hi → lo → (down + rewind to cmd) → row 1, effectCmd.
    expect(cursor()).toMatchObject({ row: 1, field: "effectCmd" });
  });

  it("two effects in a row: c40 then a08 land at row 2 effectCmd", async () => {
    // Verifies the rewind chains across multiple effects — without the
    // jump back to effectCmd the user would land on effectLo of row 1
    // and the next letter would hit the wrong nibble. Avoid Dxx for the
    // second effect because PatternBreak truncates the flattened-song
    // list and moveDown would clamp at row 1, masking what we're testing.
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40a08");
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0x40);
    expect(cellAt(1).effect).toBe(0xa);
    expect(cellAt(1).effectParam).toBe(0x08);
    expect(cursor()).toMatchObject({ row: 2, field: "effectCmd" });
  });
});

describe("effect entry: nibble independence", () => {
  it("overwriting effectCmd preserves effectParam", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // effect=C param=0x40
    placeCursor("effectCmd");
    await user.keyboard("5"); // effect=5; param should still be 0x40
    expect(cellAt(0).effect).toBe(0x5);
    expect(cellAt(0).effectParam).toBe(0x40);
  });

  it("overwriting effectHi preserves effectLo nibble", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // param=0x40
    placeCursor("effectHi");
    await user.keyboard("a"); // hi → A; lo (=0) preserved → 0xA0
    expect(cellAt(0).effectParam).toBe(0xa0);
  });

  it("overwriting effectLo preserves effectHi nibble", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // param=0x40
    placeCursor("effectLo");
    await user.keyboard("f"); // lo → F; hi (=4) preserved → 0x4F
    expect(cellAt(0).effectParam).toBe(0x4f);
  });
});

describe('effect entry: clear (".") wipes the WHOLE effect from any nibble', () => {
  it(". on effectCmd nukes both effect and param", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // effect=C param=0x40
    placeCursor("effectCmd");
    await user.keyboard(".");
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
    // Clear advances the cursor down so the user can sweep . . . to
    // erase a column quickly.
    expect(cursor()).toMatchObject({ row: 1 });
  });

  it(". on effectHi wipes the whole effect (not just the high nibble)", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // effect=C param=0x40
    placeCursor("effectHi");
    await user.keyboard(".");
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
  });

  it(". on effectLo wipes the whole effect (not just the low nibble)", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // effect=C param=0x40
    placeCursor("effectLo");
    await user.keyboard(".");
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
  });
});

describe('effect entry: repeat-last-effect (",")', () => {
  it(", copies the most recent effect above this channel into the cursor cell, then advances", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // row 0: C40 (cursor lands on row 1, effectCmd)
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0x40);
    // Move past row 1 (which already has cursor on it but is empty) to row 3:
    placeCursor("note");
    // Use applyCursor-style: place straight onto row 3 effectCmd.
    setCursorAtRow(3, "effectCmd");
    await user.keyboard(",");
    expect(cellAt(3).effect).toBe(0xc);
    expect(cellAt(3).effectParam).toBe(0x40);
    expect(cursor()).toMatchObject({ row: 4 });
  });

  it(", picks the LAST (closest above) effect when multiple rows above carry effects", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // row 0: C40
    setCursorAtRow(2, "effectCmd");
    await user.keyboard("a08"); // row 2: A08
    setCursorAtRow(5, "effectCmd");
    await user.keyboard(",");
    expect(cellAt(5).effect).toBe(0xa);
    expect(cellAt(5).effectParam).toBe(0x08);
  });

  it(", is a silent no-op when no effect exists above the cursor", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setCursorAtRow(5, "effectCmd");
    await user.keyboard(",");
    expect(cellAt(5).effect).toBe(0);
    expect(cellAt(5).effectParam).toBe(0);
    // Cursor must NOT advance — the user pressed the key by accident on a
    // row with nothing to repeat, and we shouldn't silently drag them down
    // past content as if something happened.
    expect(cursor()).toMatchObject({ row: 5 });
  });

  it(", is a no-op at row 0 (no rows above)", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard(",");
    expect(cellAt(0).effect).toBe(0);
    expect(cursor()).toMatchObject({ row: 0 });
  });

  it(", only scans the cursor's channel — effects on other channels are ignored", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    // Channel 1, row 0: F03 — should NOT be picked up by a , press on channel 0.
    setCursorAtRow(0, "effectCmd", 1);
    await user.keyboard("f03");
    setCursorAtRow(3, "effectCmd", 0);
    await user.keyboard(",");
    expect(cellAt(3).effect).toBe(0);
    expect(cellAt(3).effectParam).toBe(0);
  });
});

describe("effect entry: rendering", () => {
  it("a written effect appears as separate cmd / hi / lo characters", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40");
    const row0 = container.querySelectorAll<HTMLElement>(".patgrid__row")[0]!;
    // Scope to channel 0 — each row carries one .patgrid__cell per channel.
    const ch0 = row0.querySelectorAll<HTMLElement>(".patgrid__cell")[0]!;
    const effChars = ch0.querySelectorAll<HTMLElement>(".patgrid__eff-char");
    expect(effChars).toHaveLength(3);
    expect(effChars[0]!.textContent).toBe("C");
    expect(effChars[1]!.textContent).toBe("4");
    expect(effChars[2]!.textContent).toBe("0");
  });
});

describe('effect entry: respects the "no edit while playing" rule', () => {
  it("hex digits on effectCmd are no-ops during playback", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    setTransport("playing");
    await user.keyboard("c");
    expect(cellAt(0).effect).toBe(0);
    expect(cellAt(0).effectParam).toBe(0);
  });
});

describe("edit step: keyboard shortcuts", () => {
  it("> (Shift+.) increases edit step; < (Shift+,) decreases it", () => {
    render(() => <App />);
    expect(editStep()).toBe(1);
    // Drive raw KeyboardEvents with the position-mapped codes — the matcher
    // routes by event.code so non-QWERTY users hit the same binding.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ">",
        code: "Period",
        shiftKey: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ">",
        code: "Period",
        shiftKey: true,
      }),
    );
    expect(editStep()).toBe(3);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "<", code: "Comma", shiftKey: true }),
    );
    expect(editStep()).toBe(2);
  });

  it("< / > are no-ops while playing", () => {
    render(() => <App />);
    setEditStep(4);
    setTransport("playing");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ">",
        code: "Period",
        shiftKey: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "<", code: "Comma", shiftKey: true }),
    );
    expect(editStep()).toBe(4);
  });

  it("plain , / . do not change edit step (those are repeat-effect / clear-field)", () => {
    render(() => <App />);
    setEditStep(2);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ".", code: "Period" }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", code: "Comma" }),
    );
    expect(editStep()).toBe(2);
  });

  it("/ resets the edit step to 1", () => {
    render(() => <App />);
    setEditStep(7);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", code: "Slash" }),
    );
    expect(editStep()).toBe(1);
  });

  it("/ is a no-op while playing", () => {
    render(() => <App />);
    setEditStep(5);
    setTransport("playing");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", code: "Slash" }),
    );
    expect(editStep()).toBe(5);
  });
});

describe("edit step: pattern metapane UI", () => {
  // The +/- buttons in the metapane are the same handlers the keyboard
  // shortcuts call; this test just verifies they're wired and respond.
  it("clicking the + button increments and the − button decrements", async () => {
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    setEditStep(2);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".patternpane__editstep-btn",
    );
    expect(buttons).toHaveLength(2); // [−, +]
    await user.click(buttons[1]!); // +
    expect(editStep()).toBe(3);
    await user.click(buttons[0]!); // −
    expect(buttons[0]!);
    expect(editStep()).toBe(2);
  });

  it("the metapane displays the current edit step value", () => {
    const { container } = render(() => <App />);
    setEditStep(7);
    const value = container.querySelector(".patternpane__editstep-value")!;
    expect(value.textContent).toBe("7");
  });

  it("the +/- buttons disable while playing", () => {
    const { container } = render(() => <App />);
    setTransport("playing");
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".patternpane__editstep-btn",
    );
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(true);
  });
});

describe("edit step: cursor advance after note / hex / clear / repeat-effect", () => {
  it("note entry with editStep=2 jumps the cursor 2 rows down", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(2);
    placeCursor("note");
    await user.keyboard("a"); // enters C of currentOctave (=2) → C-2
    // Cursor was on row 0; with edit step 2 it ends up on row 2.
    expect(cursor()).toMatchObject({ row: 2, field: "note" });
  });

  it("note entry with editStep=0 keeps the cursor on the same row", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(0);
    placeCursor("note");
    await user.keyboard("a");
    expect(cellAt(0).period).toBeGreaterThan(0); // note WAS written
    expect(cursor()).toMatchObject({ row: 0, field: "note" });
  });

  it("completing a 3-nibble effect with editStep=2 advances 2 rows AND rewinds to effectCmd", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(2);
    placeCursor("effectCmd");
    await user.keyboard("c40");
    // c40 wrote row 0; cursor advances 2 rows down then rewinds the column
    // to effectCmd so the next effect can be typed in place.
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0x40);
    expect(cursor()).toMatchObject({ row: 2, field: "effectCmd" });
  });

  it("completing a 3-nibble effect with editStep=0 keeps the cursor on effectLo (no rewind)", async () => {
    // The rewind to effectCmd only fires when the cursor actually advanced
    // — at edit step 0 the user is in "stamp the same cell" mode and we
    // shouldn't tug the column back to cmd, otherwise typing the next
    // digit would overwrite the cmd nibble of the same row.
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(0);
    placeCursor("effectCmd");
    await user.keyboard("c40");
    expect(cellAt(0).effect).toBe(0xc);
    expect(cellAt(0).effectParam).toBe(0x40);
    expect(cursor()).toMatchObject({ row: 0, field: "effectLo" });
  });

  it('clear (".") with editStep=3 jumps the cursor 3 rows', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // stamp something to clear
    setEditStep(3);
    placeCursor("effectCmd");
    await user.keyboard(".");
    expect(cellAt(0).effect).toBe(0);
    expect(cursor()).toMatchObject({ row: 3 });
  });

  it('repeat-last-effect (",") respects the edit step', async () => {
    render(() => <App />);
    const user = userEvent.setup();
    placeCursor("effectCmd");
    await user.keyboard("c40"); // row 0: C40
    setEditStep(2);
    setCursorAtRow(3, "effectCmd");
    await user.keyboard(",");
    expect(cellAt(3).effect).toBe(0xc);
    expect(cellAt(3).effectParam).toBe(0x40);
    expect(cursor()).toMatchObject({ row: 5 });
  });

  it("Insert blank line (Enter) ALWAYS advances exactly one row, ignoring edit step", async () => {
    // Structural ops don't honour edit step — Enter inserts a row and the
    // cursor follows it down by exactly one regardless of the setting.
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(5);
    placeCursor("note");
    await user.keyboard("{Enter}");
    expect(cursor()).toMatchObject({ row: 1 });
  });

  it("Backspace ALWAYS moves up exactly one row, ignoring edit step", async () => {
    render(() => <App />);
    const user = userEvent.setup();
    setEditStep(5);
    setCursorAtRow(3, "note");
    await user.keyboard("{Backspace}");
    expect(cursor()).toMatchObject({ row: 2 });
  });
});
