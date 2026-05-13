import {
  clearXmRange,
  pasteXmSlice,
  readXmSlice,
} from "../core/xm/clipboardOps";
import { effectCodeForChar } from "../core/xm/effectLabels";
import {
  deleteXmCellPullUp,
  deleteXmRowPullUp,
  insertXmCellPushDown,
  insertXmRowPushDown,
  setXmCell,
  setXmChannelCount,
  setXmPatternRowCount,
  transposeRangeXm,
} from "../core/xm/mutations";
import type { XmNote, XmSong } from "../core/xm/types";
import { rowsOfPattern } from "../core/song";
import {
  type XmCursor,
  type XmField,
  XM_FIELDS,
  xmCursor,
  xmMoveDown,
  xmMoveRight,
  setXmCursor,
} from "./cursorXm";
import { xmClipboardSlice, setXmClipboardSlice } from "./clipboard";
import { editStep } from "./edit";
import { commitEditXm, setPlayPos, transport, xm2Song as song } from "./song";
import { view } from "./view";
import { previewXmNote } from "./xmPreview";
import {
  clearXmFieldPatch,
  currentXmInstrument,
  currentXmOctave,
} from "./xmEdit";
import {
  clearXmSelection,
  setXmSelection,
  setXmSelectionAnchor,
  xmSelection,
  xmSelectionAnchor,
} from "./selection";
import { createPatternEdit } from "./patternEditCore";

function visibleRowsOfXmOrder(
  s: XmSong,
  order: number,
): { first: number; last: number } {
  const patIdx = s.orders[order];
  if (patIdx === undefined) return { first: 0, last: 0 };
  return { first: 0, last: rowsOfPattern(s, patIdx) - 1 };
}

const core = createPatternEdit<XmSong, XmCursor, XmNote>({
  song,
  cursor: xmCursor,
  setCursorRaw: setXmCursor,
  selection: xmSelection,
  setSelection: setXmSelection,
  selectionAnchor: xmSelectionAnchor,
  setSelectionAnchor: setXmSelectionAnchor,
  clearSelection: clearXmSelection,
  setPlayPos,
  isPlaying: () => transport() === "playing",
  commitSong: commitEditXm,
  channelCount: (s) => s.channelCount,
  visibleRowsOfOrder: visibleRowsOfXmOrder,
  editStep,
  moveDown: xmMoveDown,
  // Why: XM clamps post-insert step to the pattern bounds; PT crosses
  // pattern boundaries. Preserves the prior xmPatternEdit behavior.
  stepDownAfterInsert: (c, s) => {
    const { last } = visibleRowsOfXmOrder(s, c.order);
    return { ...c, row: Math.min(last, c.row + 1) };
  },
  getCellAt: (s, o, r, ch) => s.patterns[s.orders[o] ?? -1]?.rows[r]?.[ch],
  setCell: (s, o, r, ch, patch) => setXmCell(s, o, r, ch, patch),
  clearFieldPatch: (cell, field) => clearXmFieldPatch(cell, field as XmField),
  getClipboard: xmClipboardSlice,
  setClipboard: setXmClipboardSlice,
  clipboardOps: {
    clearRange: clearXmRange,
    readSlice: readXmSlice,
    pasteSlice: pasteXmSlice,
    transposeRange: transposeRangeXm,
    deleteCellPullUp: deleteXmCellPullUp,
    deleteRowPullUp: deleteXmRowPullUp,
    insertCellPushDown: insertXmCellPushDown,
    insertRowPushDown: insertXmRowPushDown,
  },
});

export const applyXmCursor = core.applyCursor;
export const extendXmSelection = core.extendSelection;
export const applyXmCursorWithSong = core.applyCursorWithSong;
export const stepXmChannelLeft = core.stepChannelLeft;
export const stepXmChannelRight = core.stepChannelRight;
export const stepXmRowUp = core.stepRowUp;
export const stepXmRowDown = core.stepRowDown;
export const stepXmRowPageUp = core.stepRowPageUp;
export const stepXmRowPageDown = core.stepRowPageDown;
export const clearXmAtCursor = core.clearAtCursor;
export const repeatLastXmEffectFromAbove = core.repeatLastEffectFromAbove;
export const selectAllXmStep = core.selectAllStep;
export const copyXmSelection = core.copySelection;
export const cutXmSelection = core.cutSelection;
export const pasteXmAtCursor = core.pasteAtCursor;
export const transposeXmAtCursor = core.transposeAtCursor;
export const backspaceXmCell = core.backspaceCell;
export const backspaceXmRow = core.backspaceRow;
export const deleteXmSelection = core.deleteSelection;
export const insertEmptyXmCell = core.insertEmptyCell;
export const insertEmptyXmRow = core.insertEmptyRow;

// Why: 1-based 1..96 = C-0..B-7; piano-row keymap covers 0..16 on top of
// the currentXmOctave base.
function noteForOffset(offset: number): number | null {
  const base = currentXmOctave() * 12;
  const note = base + offset + 1;
  if (note < 1 || note > 96) return null;
  return note;
}

export function enterXmNote(semitoneOffset: number): void {
  if (transport() === "playing") return;
  const c = xmCursor();
  if (c.field !== "note") return;
  const note = noteForOffset(semitoneOffset);
  if (note === null) return;
  const inst = currentXmInstrument();
  commitEditXm((s) =>
    setXmCell(s, c.order, c.row, c.channel, { note, instrument: inst }),
  );
  core.advanceByEditStep();
  previewXmNote(semitoneOffset);
}

export function onXmPianoKey(semitoneOffset: number): void {
  if (view() === "sample") previewXmNote(semitoneOffset);
  else enterXmNote(semitoneOffset);
}

export function enterXmKeyOff(): void {
  if (transport() === "playing") return;
  const c = xmCursor();
  if (c.field !== "note") return;
  commitEditXm((s) => setXmCell(s, c.order, c.row, c.channel, { note: 97 }));
  core.advanceByEditStep();
}

// Why: auto-advance pattern mirrors PT — instHi/volHi/effectHi step right,
// instLo/volLo land on next row, effectLo lands then rewinds to effectCmd
// at step>0 (three-digit effect rhythm).
export function enterXmHexDigit(digit: number): void {
  if (transport() === "playing") return;
  const c = xmCursor();
  const s = song();
  if (!s) return;
  const pat = s.patterns[s.orders[c.order] ?? -1];
  const cell = pat?.rows[c.row]?.[c.channel];
  if (!cell) return;
  const nib = digit & 0x0f;

  let stepsRight = false;
  let stepsRewind = false;

  switch (c.field) {
    case "instHi": {
      const raw = (nib << 4) | (cell.instrument & 0x0f);
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, {
          instrument: Math.min(128, raw),
        }),
      );
      stepsRight = true;
      break;
    }
    case "instLo": {
      const raw = (cell.instrument & 0xf0) | nib;
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, {
          instrument: Math.min(128, raw),
        }),
      );
      break;
    }
    case "volHi": {
      // Why: low nibble of volume column is magnitude — patching only the
      // high nibble preserves it. Empty (high=0) resets the column entirely.
      const newByte = nib === 0 ? 0 : (nib << 4) | (cell.volumeColumn & 0x0f);
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, { volumeColumn: newByte }),
      );
      stepsRight = true;
      break;
    }
    case "volLo": {
      const newByte = (cell.volumeColumn & 0xf0) | nib;
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, { volumeColumn: newByte }),
      );
      break;
    }
    case "effectHi": {
      const param = (nib << 4) | (cell.effectParam & 0x0f);
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, { effectParam: param }),
      );
      stepsRight = true;
      break;
    }
    case "effectLo": {
      const param = (cell.effectParam & 0xf0) | nib;
      commitEditXm((s) =>
        setXmCell(s, c.order, c.row, c.channel, { effectParam: param }),
      );
      stepsRewind = true;
      break;
    }
    default:
      return;
  }

  if (stepsRight) {
    applyXmCursor(xmMoveRight(xmCursor(), s));
  } else {
    core.advanceByEditStep();
    if (stepsRewind && editStep() > 0) {
      const idx = XM_FIELDS.indexOf("effectCmd");
      applyXmCursor({ ...xmCursor(), field: XM_FIELDS[idx]! });
    }
  }
}

// Why: accepts hex 0..F and letters G..X for XM extended commands
// (G=global vol, K=key off, P=pan slide, T=tremor, X=X-extended…).
// Anything else is a no-op so a stray keystroke can't write garbage.
export function enterXmEffectChar(char: string): void {
  if (transport() === "playing") return;
  const c = xmCursor();
  if (c.field !== "effectCmd") return;
  const code = effectCodeForChar(char);
  if (code === null) return;
  const s = song();
  if (!s) return;
  commitEditXm((s) =>
    setXmCell(s, c.order, c.row, c.channel, { effect: code }),
  );
  applyXmCursor(xmMoveRight(xmCursor(), s));
}

export function setXmRowCountAtCursor(rowCount: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  const patternIndex = s.orders[c.order];
  if (patternIndex === undefined) return;
  commitEditXm((s) => setXmPatternRowCount(s, patternIndex, rowCount));
  const after = song();
  if (!after) return;
  const newRows = after.patterns[patternIndex]?.rowCount ?? 0;
  if (c.row >= newRows && newRows > 0) {
    applyXmCursor({ ...c, row: newRows - 1 });
  }
}

export function setXmChannelCountAction(channelCount: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  commitEditXm((s) => setXmChannelCount(s, channelCount));
  const after = song();
  if (!after) return;
  const c = xmCursor();
  if (c.channel >= after.channelCount && after.channelCount > 0) {
    applyXmCursor({ ...c, channel: after.channelCount - 1 });
  }
}
