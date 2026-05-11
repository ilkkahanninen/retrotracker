import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyXmSong } from "~/core/xm/format";
import { resetXmCursor, setXmCursor, xmCursor } from "~/state/cursorXm";
import {
  applyXmCursor,
  backspaceXmCell,
  clearXmAtCursor,
  enterXmEffectChar,
  enterXmHexDigit,
  enterXmKeyOff,
  enterXmNote,
  setXmChannelCountAction,
  setXmRowCountAtCursor,
} from "~/state/xmPatternEdit";
import { setEditStep } from "~/state/edit";
import { setCurrentXmInstrument, setCurrentXmOctave } from "~/state/xmEdit";
import { clearHistory, setSong, setTransport, xm2Song } from "~/state/song";

function freshXmSong() {
  setSong(emptyXmSong());
  resetXmCursor();
  setCurrentXmOctave(4);
  setCurrentXmInstrument(1);
  setEditStep(1);
  setTransport("idle");
  clearHistory();
}

beforeEach(freshXmSong);
afterEach(() => {
  setSong(null);
  clearHistory();
});

/** Read the cell currently under the FT2 cursor. */
function cellAtCursor() {
  const c = xmCursor();
  const s = xm2Song();
  if (!s) throw new Error("no XM song");
  const patIdx = s.orders[c.order]!;
  return s.patterns[patIdx]!.rows[c.row]![c.channel]!;
}

describe("enterXmNote", () => {
  it("writes a 1-based XM note number using currentXmOctave * 12 + offset + 1", () => {
    setCurrentXmOctave(4);
    enterXmNote(0); // C in octave 4 → note 4*12 + 0 + 1 = 49
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(49);
  });

  it("stamps currentXmInstrument alongside the note", () => {
    setCurrentXmInstrument(7);
    enterXmNote(0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(7);
  });

  it("advances by editStep rows after writing", () => {
    setEditStep(2);
    enterXmNote(0);
    expect(xmCursor().row).toBe(2);
  });

  it("does not write outside the note field", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    enterXmNote(0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
  });

  it("respects the 1..96 range", () => {
    setCurrentXmOctave(7);
    // C-7 = 7*12 + 0 + 1 = 85, B-7 = 96 → offset 11
    enterXmNote(11);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(96);
  });

  it("no-ops when the resulting note overflows", () => {
    setCurrentXmOctave(7);
    // Offset 16 would be 7*12 + 16 + 1 = 101 → out of range, refuse.
    enterXmNote(16);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
  });
});

describe("enterXmKeyOff", () => {
  it("writes note 97 (the XM key-off marker)", () => {
    enterXmKeyOff();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(97);
  });

  it("only fires on the note field", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volHi" });
    enterXmKeyOff();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
  });
});

describe("enterXmHexDigit — instrument nibbles", () => {
  it("instHi sets high nibble and advances cursor to instLo", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    enterXmHexDigit(0x1);
    expect(xmCursor().field).toBe("instLo");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(0x10);
  });

  it("instLo sets low nibble and advances by editStep", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instLo" });
    enterXmHexDigit(0xa);
    expect(xmCursor().row).toBe(1);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(0x0a);
  });

  it("clamps instrument to the FT2 cap of 128", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    // High nibble F + low nibble F = 0xff → cap to 128.
    enterXmHexDigit(0xf);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instLo" });
    enterXmHexDigit(0xf);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(128);
  });
});

describe("enterXmHexDigit — volume column", () => {
  it("volHi=0 clears the column entirely", () => {
    // Pre-fill so we can see it cleared.
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volHi" });
    enterXmHexDigit(0x4); // → kind 4 (set vol 0x40), advances to volLo
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volLo" });
    enterXmHexDigit(0x5); // → magnitude 5, byte = 0x45
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().volumeColumn).toBe(0x45);

    setXmCursor({ order: 0, row: 0, channel: 0, field: "volHi" });
    enterXmHexDigit(0x0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().volumeColumn).toBe(0);
  });

  it("volHi advances to volLo, volLo advances by editStep", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volHi" });
    enterXmHexDigit(0x6); // vol slide down
    expect(xmCursor().field).toBe("volLo");
    enterXmHexDigit(0x4);
    expect(xmCursor().row).toBe(1);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().volumeColumn).toBe(0x64);
  });
});

describe("enterXmHexDigit — effect param nibbles", () => {
  it("effectHi advances to effectLo", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectHi" });
    enterXmHexDigit(0x4);
    expect(xmCursor().field).toBe("effectLo");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effectParam).toBe(0x40);
  });

  it("effectLo advances by editStep, then rewinds to effectCmd", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectLo" });
    enterXmHexDigit(0x5);
    expect(xmCursor()).toMatchObject({ row: 1, field: "effectCmd" });
  });

  it("effectLo at editStep=0 stays put without rewinding", () => {
    setEditStep(0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectLo" });
    enterXmHexDigit(0x5);
    expect(xmCursor()).toMatchObject({ row: 0, field: "effectLo" });
  });
});

describe("enterXmEffectChar", () => {
  it("sets effect=0xC for 'C' and advances to effectHi", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectCmd" });
    enterXmEffectChar("c");
    expect(xmCursor().field).toBe("effectHi");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0x0c);
  });

  it("accepts XM extended letters (G..X)", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectCmd" });
    enterXmEffectChar("g"); // global vol = 0x10
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0x10);

    setXmCursor({ order: 0, row: 1, channel: 0, field: "effectCmd" });
    enterXmEffectChar("k"); // key off = 0x14
    setXmCursor({ order: 0, row: 1, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0x14);
  });

  it("ignores unknown letters", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectCmd" });
    enterXmEffectChar("?");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0);
  });

  it("only fires on effectCmd field", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectHi" });
    enterXmEffectChar("c");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0);
  });
});

describe("clearXmAtCursor", () => {
  it("clearing on note wipes note + instrument", () => {
    enterXmNote(0); // writes note + instrument
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    clearXmAtCursor();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
    expect(cellAtCursor().instrument).toBe(0);
  });

  it("clearing on instHi keeps the low nibble", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    enterXmHexDigit(0x3); // → instrument = 0x30, cursor on instLo
    enterXmHexDigit(0x7); // → instrument = 0x37, cursor steps row
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    clearXmAtCursor();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(0x07);
  });

  it("clearing any volume nibble wipes both halves", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volHi" });
    enterXmHexDigit(0x5);
    enterXmHexDigit(0x9);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "volLo" });
    clearXmAtCursor();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().volumeColumn).toBe(0);
  });

  it("clearing any effect nibble wipes the whole effect", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectCmd" });
    enterXmEffectChar("c");
    enterXmHexDigit(0x4);
    enterXmHexDigit(0x0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "effectHi" });
    clearXmAtCursor();
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().effect).toBe(0);
    expect(cellAtCursor().effectParam).toBe(0);
  });
});

describe("backspaceXmCell", () => {
  it("clears the cell above and steps the cursor up", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    enterXmNote(0); // row 0
    setEditStep(0);
    setXmCursor({ order: 0, row: 1, channel: 0, field: "note" });
    enterXmNote(2); // row 1, D-4
    setXmCursor({ order: 0, row: 1, channel: 0, field: "note" });

    backspaceXmCell();

    expect(xmCursor().row).toBe(0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
    expect(cellAtCursor().instrument).toBe(0);
  });

  it("no-op at row 0", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    backspaceXmCell();
    expect(xmCursor().row).toBe(0);
  });
});

describe("setXmRowCountAtCursor", () => {
  it("resizes the cursor's pattern", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    setXmRowCountAtCursor(32);
    expect(xm2Song()!.patterns[0]!.rowCount).toBe(32);
  });

  it("clamps the cursor row when shrinking past it", () => {
    setXmCursor({ order: 0, row: 50, channel: 0, field: "note" });
    setXmRowCountAtCursor(16);
    expect(xmCursor().row).toBe(15);
  });

  it("rejects out-of-range row counts", () => {
    setXmRowCountAtCursor(0);
    expect(xm2Song()!.patterns[0]!.rowCount).toBe(64);
    setXmRowCountAtCursor(257);
    expect(xm2Song()!.patterns[0]!.rowCount).toBe(64);
  });

  it("preserves cells in rows that survive a shrink", () => {
    enterXmNote(0); // row 0, then editStep advances
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    setXmRowCountAtCursor(16);
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(49);
  });

  it("no-ops while playing", () => {
    setTransport("playing");
    setXmRowCountAtCursor(16);
    expect(xm2Song()!.patterns[0]!.rowCount).toBe(64);
  });
});

describe("setXmChannelCountAction", () => {
  it("widens the song to the requested channel count", () => {
    setXmChannelCountAction(16);
    expect(xm2Song()!.channelCount).toBe(16);
  });

  it("clamps the cursor's channel when shrinking past it", () => {
    setXmChannelCountAction(16);
    setXmCursor({ order: 0, row: 0, channel: 12, field: "note" });
    setXmChannelCountAction(4);
    expect(xmCursor().channel).toBe(3);
  });

  it("rejects out-of-range values", () => {
    setXmChannelCountAction(0); // below 2 — refuses
    expect(xm2Song()!.channelCount).toBe(8);
    setXmChannelCountAction(64); // above 32 — refuses
    expect(xm2Song()!.channelCount).toBe(8);
  });

  it("no-ops while playing", () => {
    setTransport("playing");
    setXmChannelCountAction(16);
    expect(xm2Song()!.channelCount).toBe(8);
  });
});

describe("transport gating", () => {
  it("refuses note entry while playing", () => {
    setTransport("playing");
    enterXmNote(0);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().note).toBe(0);
  });

  it("refuses hex digit entry while playing", () => {
    setTransport("playing");
    setXmCursor({ order: 0, row: 0, channel: 0, field: "instHi" });
    enterXmHexDigit(0xa);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    expect(cellAtCursor().instrument).toBe(0);
  });

  it("refuses cursor application while playing", () => {
    setTransport("playing");
    applyXmCursor({ order: 0, row: 9, channel: 1, field: "instLo" });
    expect(xmCursor().row).toBe(0);
  });
});
