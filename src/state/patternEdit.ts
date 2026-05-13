import type { ModSong, Note } from "../core/mod/types";
import { CHANNELS, ROWS_PER_PATTERN } from "../core/mod/types";
import { PERIOD_TABLE } from "../core/mod/format";
import { visibleRowRangeForOrder } from "../core/mod/flatten";
import { clearRange, pasteSlice, readSlice } from "../core/mod/clipboardOps";
import {
  deleteCellPullUp,
  deleteRowPullUp,
  insertCellPushDown,
  insertRowPushDown,
  setCell,
  transposeRange,
} from "../core/mod/mutations";
import {
  cursor,
  moveDown,
  moveRight,
  setCursor,
  type Cursor,
  type Field,
} from "./cursor";
import {
  clearSelection,
  selection,
  selectionAnchor,
  setSelection,
  setSelectionAnchor,
} from "./selection";
import { clipboardSlice, setClipboardSlice } from "./clipboard";
import {
  clearFieldPatch,
  currentOctave,
  currentSample,
  editStep,
} from "./edit";
import { commitEdit, pt2Song as song, setPlayPos, transport } from "./song";
import { triggerPreview } from "./playback";
import { toggleMute, toggleSolo } from "./channelMute";
import { getWorkbench } from "./sampleWorkbench";
import { setSampleSelection } from "./sampleSelection";
import { view } from "./view";
import { createPatternEdit } from "./patternEditCore";

const core = createPatternEdit<ModSong, Cursor, Note>({
  song,
  cursor,
  setCursorRaw: setCursor,
  selection,
  setSelection,
  selectionAnchor,
  setSelectionAnchor,
  clearSelection,
  setPlayPos,
  isPlaying: () => transport() === "playing",
  commitSong: commitEdit,
  channelCount: () => CHANNELS,
  visibleRowsOfOrder: (s, order) =>
    visibleRowRangeForOrder(s, order) ?? {
      first: 0,
      last: ROWS_PER_PATTERN - 1,
    },
  editStep,
  moveDown,
  stepDownAfterInsert: (c, s) => moveDown(c, s),
  getCellAt: (s, o, r, ch) => s.patterns[s.orders[o] ?? -1]?.rows[r]?.[ch],
  setCell: (s, o, r, ch, patch) => setCell(s, o, r, ch, patch),
  clearFieldPatch: (cell, field) => clearFieldPatch(cell, field as Field),
  getClipboard: clipboardSlice,
  setClipboard: setClipboardSlice,
  clipboardOps: {
    clearRange,
    readSlice,
    pasteSlice,
    transposeRange,
    deleteCellPullUp,
    deleteRowPullUp,
    insertCellPushDown,
    insertRowPushDown,
  },
});

export const applyCursor = core.applyCursor;
export const extendSelection = core.extendSelection;
export const applyCursorWithSong = core.applyCursorWithSong;
export const stepChannelLeft = core.stepChannelLeft;
export const stepChannelRight = core.stepChannelRight;
export const stepRowUp = core.stepRowUp;
export const stepRowDown = core.stepRowDown;
export const stepRowPageUp = core.stepRowPageUp;
export const stepRowPageDown = core.stepRowPageDown;
export const clearAtCursor = core.clearAtCursor;
export const repeatLastEffectFromAbove = core.repeatLastEffectFromAbove;
export const selectAllStep = core.selectAllStep;
export const copySelection = core.copySelection;
export const cutSelection = core.cutSelection;
export const pasteAtCursor = core.pasteAtCursor;
export const transposeAtCursor = core.transposeAtCursor;
export const backspaceCell = core.backspaceCell;
export const backspaceRow = core.backspaceRow;
export const deleteSelection = core.deleteSelection;
export const insertEmptyCell = core.insertEmptyCell;
export const insertEmptyRow = core.insertEmptyRow;

export function enterNote(semitoneOffset: number): void {
  if (transport() === "playing") return;
  const c = cursor();
  if (c.field !== "note") return;
  const s = song();
  if (!s) return;
  const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
  if (noteIdx < 0 || noteIdx >= 36) return;
  const period = PERIOD_TABLE[0]![noteIdx]!;
  const sampleNum = currentSample();

  commitEdit((song) =>
    setCell(song, c.order, c.row, c.channel, {
      period,
      sample: sampleNum,
    }),
  );
  core.advanceByEditStep();

  const sample = s.samples[sampleNum - 1];
  if (sample) triggerPreview(sampleNum - 1, sample, period);
}

export function previewSampleAtPitch(semitoneOffset: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
  if (noteIdx < 0 || noteIdx >= 36) return;
  const period = PERIOD_TABLE[0]![noteIdx]!;
  const sample = s.samples[currentSample() - 1];
  if (sample) triggerPreview(currentSample() - 1, sample, period);
}

export function onPianoKey(semitoneOffset: number): void {
  if (view() === "sample") previewSampleAtPitch(semitoneOffset);
  else enterNote(semitoneOffset);
}

// Why: auto-advance pattern — sampleHi→sampleLo→down,
// effectCmd→effectHi→effectLo→down (with rewind to effectCmd at step>0
// for PT/FT2's three-digit effect rhythm). Sample numbers clamp to PT's
// 1..31 (5-bit field).
export function enterHexDigit(digit: number): void {
  if (transport() === "playing") return;
  const c = cursor();
  const s = song();
  if (!s) return;
  const pat = s.patterns[s.orders[c.order] ?? -1];
  const note = pat?.rows[c.row]?.[c.channel];
  if (!note) return;

  let patch: Partial<typeof note> | null = null;
  switch (c.field) {
    case "sampleHi": {
      const raw = ((digit & 0x0f) << 4) | (note.sample & 0x0f);
      patch = { sample: Math.min(31, raw) };
      break;
    }
    case "sampleLo": {
      const raw = (note.sample & 0xf0) | (digit & 0x0f);
      patch = { sample: Math.min(31, raw) };
      break;
    }
    case "effectCmd":
      patch = { effect: digit & 0x0f };
      break;
    case "effectHi":
      patch = {
        effectParam: ((digit & 0x0f) << 4) | (note.effectParam & 0x0f),
      };
      break;
    case "effectLo":
      patch = { effectParam: (note.effectParam & 0xf0) | (digit & 0x0f) };
      break;
    default:
      return;
  }

  commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
  const stepsRight =
    c.field === "sampleHi" || c.field === "effectCmd" || c.field === "effectHi";
  if (stepsRight) {
    applyCursor(moveRight(cursor()));
  } else {
    core.advanceByEditStep();
    // Why: at edit step 0 the cursor STAYS on effectLo for chord-style
    // overwrites — only rewind to effectCmd when stepping rows.
    if (c.field === "effectLo" && editStep() > 0) {
      applyCursor({ ...cursor(), field: "effectCmd" });
    }
  }
}

export function selectAllSample(): void {
  const slot = currentSample() - 1;
  if (getWorkbench(slot)?.source.kind === "chiptune") return;
  const s = song();
  const len = s?.samples[slot]?.data.length ?? 0;
  if (len < 2) return;
  setSampleSelection({ start: 0, end: len });
}

export function toggleChannelMute(channel: number): void {
  toggleMute(channel);
}
export function toggleChannelSolo(channel: number): void {
  toggleSolo(channel);
}
