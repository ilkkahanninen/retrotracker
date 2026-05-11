import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyXmSong } from "~/core/xm/format";
import { setXmCell } from "~/core/xm/mutations";
import { resetXmCursor, setXmCursor, xmCursor } from "~/state/cursorXm";
import { xmClipboardSlice, setXmClipboardSlice } from "~/state/clipboardXm";
import {
  clearXmSelection,
  setXmSelection,
  xmSelection,
} from "~/state/selectionXm";
import {
  applyXmCursor,
  copyXmSelection,
  cutXmSelection,
  deleteXmSelection,
  extendXmSelection,
  pasteXmAtCursor,
  selectAllXmStep,
  stepXmChannelLeft,
  stepXmChannelRight,
  stepXmRowDown,
  stepXmRowUp,
} from "~/state/xmPatternEdit";
import { clearHistory, setSong, setTransport, xm2Song } from "~/state/song";

function freshXmSong() {
  setSong(emptyXmSong());
  resetXmCursor();
  setTransport("idle");
  clearHistory();
  clearXmSelection();
  setXmClipboardSlice(null);
}

beforeEach(freshXmSong);
afterEach(() => {
  setSong(null);
  clearHistory();
  clearXmSelection();
  setXmClipboardSlice(null);
});

describe("FT2 selection: extension via shift-step helpers", () => {
  it("first extendXmSelection re-anchors at the cursor's pre-move position", () => {
    setXmCursor({ order: 0, row: 5, channel: 2, field: "note" });
    extendXmSelection(stepXmRowDown(xmCursor()));
    const sel = xmSelection();
    expect(sel).not.toBeNull();
    expect(sel!.startRow).toBe(5);
    expect(sel!.endRow).toBe(6);
    expect(sel!.startChannel).toBe(2);
    expect(sel!.endChannel).toBe(2);
  });

  it("subsequent extends keep the original anchor", () => {
    setXmCursor({ order: 0, row: 5, channel: 2, field: "note" });
    extendXmSelection(stepXmRowDown(xmCursor()));
    extendXmSelection(stepXmRowDown(xmCursor()));
    const sel = xmSelection()!;
    expect(sel.startRow).toBe(5);
    expect(sel.endRow).toBe(7);
  });

  it("extends across channels", () => {
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    extendXmSelection(stepXmChannelRight(xmCursor()));
    extendXmSelection(stepXmChannelRight(xmCursor()));
    const sel = xmSelection()!;
    expect(sel.startChannel).toBe(0);
    expect(sel.endChannel).toBe(2);
  });

  it("normalises so start <= end when extending up/left", () => {
    setXmCursor({ order: 0, row: 5, channel: 3, field: "note" });
    extendXmSelection(stepXmRowUp(xmCursor()));
    extendXmSelection(stepXmChannelLeft(xmCursor()));
    const sel = xmSelection()!;
    expect(sel.startRow).toBeLessThanOrEqual(sel.endRow);
    expect(sel.startChannel).toBeLessThanOrEqual(sel.endChannel);
  });

  it("applyXmCursor drops the selection (plain navigation)", () => {
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 5,
      startChannel: 0,
      endChannel: 1,
    });
    applyXmCursor({ order: 0, row: 10, channel: 0, field: "note" });
    expect(xmSelection()).toBeNull();
  });
});

describe("Cmd+A — selectAllXmStep cycle", () => {
  it("first press selects the cursor's whole channel", () => {
    setXmCursor({ order: 0, row: 0, channel: 2, field: "note" });
    selectAllXmStep();
    const sel = xmSelection()!;
    expect(sel.startChannel).toBe(2);
    expect(sel.endChannel).toBe(2);
    expect(sel.startRow).toBe(0);
    expect(sel.endRow).toBe(63);
  });

  it("second press expands to the whole pattern", () => {
    setXmCursor({ order: 0, row: 0, channel: 2, field: "note" });
    selectAllXmStep();
    selectAllXmStep();
    const sel = xmSelection()!;
    expect(sel.startChannel).toBe(0);
    expect(sel.endChannel).toBe(xm2Song()!.channelCount - 1);
  });

  it("third press is a no-op (no further cycle)", () => {
    setXmCursor({ order: 0, row: 0, channel: 2, field: "note" });
    selectAllXmStep();
    selectAllXmStep();
    const after2 = xmSelection();
    selectAllXmStep();
    expect(xmSelection()).toEqual(after2);
  });
});

describe("clipboard: copy / cut / paste", () => {
  it("copy without a selection captures the cursor's single cell", () => {
    let s = xm2Song()!;
    s = setXmCell(s, 0, 5, 1, { note: 49 });
    setSong(s);
    setXmCursor({ order: 0, row: 5, channel: 1, field: "note" });
    copyXmSelection();
    const clip = xmClipboardSlice();
    expect(clip).not.toBeNull();
    expect(clip!.rows.length).toBe(1);
    expect(clip!.rows[0]![0]!.note).toBe(49);
  });

  it("copy with a selection captures the rectangle", () => {
    let s = xm2Song()!;
    s = setXmCell(s, 0, 0, 0, { note: 49 });
    s = setXmCell(s, 0, 1, 0, { note: 50 });
    setSong(s);
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 1,
      startChannel: 0,
      endChannel: 0,
    });
    copyXmSelection();
    const clip = xmClipboardSlice()!;
    expect(clip.rows[0]![0]!.note).toBe(49);
    expect(clip.rows[1]![0]!.note).toBe(50);
  });

  it("cut clears the source rectangle and stores the slice", () => {
    let s = xm2Song()!;
    s = setXmCell(s, 0, 0, 0, { note: 49 });
    setSong(s);
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 0,
      startChannel: 0,
      endChannel: 0,
    });
    cutXmSelection();
    expect(xmClipboardSlice()!.rows[0]![0]!.note).toBe(49);
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(0);
    expect(xmSelection()).toBeNull();
  });

  it("paste stamps the slice at the cursor and steps the cursor down", () => {
    setXmClipboardSlice({
      rows: [
        [
          {
            note: 49,
            instrument: 1,
            volumeColumn: 0,
            effect: 0,
            effectParam: 0,
          },
        ],
      ],
    });
    setXmCursor({ order: 0, row: 7, channel: 2, field: "note" });
    pasteXmAtCursor();
    expect(xm2Song()!.patterns[0]!.rows[7]![2]!.note).toBe(49);
    expect(xmCursor().row).toBe(8);
  });

  it("paste is a no-op for an empty clipboard", () => {
    setXmClipboardSlice(null);
    setXmCursor({ order: 0, row: 0, channel: 0, field: "note" });
    pasteXmAtCursor();
    expect(xmCursor().row).toBe(0);
  });

  it("Delete clears the selected range", () => {
    let s = xm2Song()!;
    s = setXmCell(s, 0, 5, 0, { note: 49 });
    setSong(s);
    setXmSelection({
      order: 0,
      startRow: 5,
      endRow: 5,
      startChannel: 0,
      endChannel: 0,
    });
    deleteXmSelection();
    expect(xm2Song()!.patterns[0]!.rows[5]![0]!.note).toBe(0);
  });
});

describe("transport gating", () => {
  it("clipboard ops no-op while playing", () => {
    let s = xm2Song()!;
    s = setXmCell(s, 0, 0, 0, { note: 49 });
    setSong(s);
    setTransport("playing");
    setXmSelection({
      order: 0,
      startRow: 0,
      endRow: 0,
      startChannel: 0,
      endChannel: 0,
    });
    cutXmSelection();
    expect(xm2Song()!.patterns[0]!.rows[0]![0]!.note).toBe(49);
  });
});
