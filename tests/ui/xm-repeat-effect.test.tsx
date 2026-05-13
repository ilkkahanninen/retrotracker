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

function setEffectAt(
  row: number,
  channel: number,
  effect: number,
  param: number,
): void {
  const cell = xm2Song()!.patterns[0]!.rows[row]![channel]!;
  cell.effect = effect;
  cell.effectParam = param;
}

describe("FT2 repeat-last-effect (,)", () => {
  it("copies the most recent non-empty effect on this channel to the cursor", async () => {
    render(() => <App />);
    setEffectAt(0, 0, 0xc, 0x40);
    setXmCursor({ ...xmCursor(), row: 4 });
    const user = userEvent.setup();
    await user.keyboard(",");
    const c = xm2Song()!.patterns[0]!.rows[4]![0]!;
    expect(c.effect).toBe(0xc);
    expect(c.effectParam).toBe(0x40);
  });

  it("walks past empty effect cells, picks nearest non-empty above", async () => {
    render(() => <App />);
    setEffectAt(1, 0, 0xa, 0x12);
    // row 2 and 3 stay empty
    setXmCursor({ ...xmCursor(), row: 4 });
    const user = userEvent.setup();
    await user.keyboard(",");
    const c = xm2Song()!.patterns[0]!.rows[4]![0]!;
    expect(c.effect).toBe(0xa);
    expect(c.effectParam).toBe(0x12);
  });

  it("is a no-op when no prior effect exists", async () => {
    render(() => <App />);
    setXmCursor({ ...xmCursor(), row: 3 });
    const user = userEvent.setup();
    await user.keyboard(",");
    const c = xm2Song()!.patterns[0]!.rows[3]![0]!;
    expect(c.effect).toBe(0);
    expect(c.effectParam).toBe(0);
  });

  it("ignores prior effects on OTHER channels", async () => {
    render(() => <App />);
    setEffectAt(0, 1, 0xc, 0x40); // channel 1 has it; cursor is on channel 0
    setXmCursor({ ...xmCursor(), row: 4, channel: 0 });
    const user = userEvent.setup();
    await user.keyboard(",");
    const c = xm2Song()!.patterns[0]!.rows[4]![0]!;
    expect(c.effect).toBe(0);
    expect(c.effectParam).toBe(0);
  });
});
