import { CHANNELS, ROWS_PER_PATTERN } from "../core/mod/types";
import { PERIOD_TABLE } from "../core/mod/format";
import { visibleRowRangeForOrder } from "../core/mod/flatten";
import {
  clearRange,
  pasteSlice,
  readSlice,
  type PatternRange,
} from "../core/mod/clipboardOps";
import {
  deleteCellPullUp,
  deleteRowPullUp,
  insertCellPushDown,
  insertRowPushDown,
  setCell,
  transposeRange,
} from "../core/mod/mutations";
import { cursor, moveDown, moveRight, setCursor, type Cursor } from "./cursor";
import {
  clearSelection,
  makeSelection,
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
import { commitEdit, setPlayPos, song, transport } from "./song";
import { triggerPreview } from "./playback";
import { toggleMute, toggleSolo } from "./channelMute";
import { getWorkbench } from "./sampleWorkbench";
import { setSampleSelection } from "./sampleSelection";
import { view } from "./view";

/**
 * Pattern-grid editing handlers + the cursor / selection step helpers.
 * Every song-mutating handler gates on `transport !== "playing"` —
 * `commitEdit`'s own gate would catch it too, but checking up front
 * lets us skip cursor / selection updates that go with each edit.
 *
 * Step helpers (`stepChannelLeft`, `stepRowUp`, …) are pure
 * Cursor → Cursor functions. `applyCursor` / `extendSelection` are the
 * single committing path: they update `cursor` AND `playPos` so the
 * visible playhead tracks the user's edit position.
 */

// ─── Cursor / selection committing path ─────────────────────────────────

/**
 * Drops the active range selection AND its anchor — once the user
 * starts navigating with arrows / clicks, the highlighted rectangle is
 * stale. Shift-arrow / drag go through `extendSelection` instead.
 */
export function applyCursor(next: Cursor): void {
  if (transport() === "playing") return;
  setCursor(next);
  setPlayPos({ order: next.order, row: next.row });
  clearSelection();
}

/**
 * The first call after a plain navigation re-anchors at the cursor's
 * PRE-MOVE position so the originating cell is included. Selection is
 * single-pattern: a cross-order move drops the rectangle and re-anchors
 * at the new order, since spanning orders has no well-defined extent.
 */
export function extendSelection(next: Cursor): void {
  if (transport() === "playing") return;
  const before = cursor();
  let anchor = selectionAnchor();
  if (!anchor) {
    anchor = {
      order: before.order,
      row: before.row,
      channel: before.channel,
    };
    setSelectionAnchor(anchor);
  }
  setCursor(next);
  setPlayPos({ order: next.order, row: next.row });
  if (next.order !== anchor.order) {
    const reAnchor = {
      order: next.order,
      row: next.row,
      channel: next.channel,
    };
    setSelectionAnchor(reAnchor);
    setSelection(null);
    return;
  }
  setSelection(
    makeSelection(
      anchor.order,
      anchor.row,
      anchor.channel,
      next.row,
      next.channel,
    ),
  );
}

/** applyCursor variant for movement functions that need to read the ModSong. */
export function applyCursorWithSong(
  fn: (c: Cursor, s: NonNullable<ReturnType<typeof song>>) => Cursor,
): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  applyCursor(fn(cursor(), s));
}

// ─── Shift+arrow range extension ────────────────────────────────────────
// Shift+left/right hops a WHOLE channel at a time (skipping the per-cell
// sub-fields the user traverses during plain editing) — sweeping out a
// rectangle, the sub-field doesn't matter. Selection rectangle is
// single-pattern by design (see PatternSelection in state/selection.ts).

export const stepChannelLeft = (c: Cursor): Cursor => ({
  ...c,
  channel: Math.max(0, c.channel - 1),
});
export const stepChannelRight = (c: Cursor): Cursor => ({
  ...c,
  channel: Math.min(CHANNELS - 1, c.channel + 1),
});

// Clamp row movement to the visible-row range of the cursor's order so
// shift+arrow / shift+page can't extend into Dxx-truncated territory.
function visibleRows(order: number): { first: number; last: number } {
  const s = song();
  return s
    ? (visibleRowRangeForOrder(s, order) ?? {
        first: 0,
        last: ROWS_PER_PATTERN - 1,
      })
    : { first: 0, last: ROWS_PER_PATTERN - 1 };
}

export const stepRowUp = (c: Cursor): Cursor => ({
  ...c,
  row: Math.max(visibleRows(c.order).first, c.row - 1),
});
export const stepRowDown = (c: Cursor): Cursor => ({
  ...c,
  row: Math.min(visibleRows(c.order).last, c.row + 1),
});
export const stepRowPageUp = (c: Cursor, n: number): Cursor => ({
  ...c,
  row: Math.max(visibleRows(c.order).first, c.row - Math.max(1, n)),
});
export const stepRowPageDown = (c: Cursor, n: number): Cursor => ({
  ...c,
  row: Math.min(visibleRows(c.order).last, c.row + Math.max(1, n)),
});

// ─── Cursor advance ────────────────────────────────────────────────────

/** One-row step for structural ops (Backspace pull-up, Enter push-down). */
function advanceCursor(): void {
  const s = song();
  if (!s) return;
  applyCursor(moveDown(cursor(), s));
}

/**
 * FT2-style: advance by `editStep()` rows after a content edit. Step 0
 * leaves the cursor put — useful for stamping chords on the same cell.
 */
function advanceByEditStep(): void {
  const s = song();
  if (!s) return;
  const step = editStep();
  if (step <= 0) return;
  let next = cursor();
  for (let i = 0; i < step; i++) next = moveDown(next, s);
  applyCursor(next);
}

// ─── Note / hex entry ───────────────────────────────────────────────────

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
  advanceByEditStep();

  const sample = s.samples[sampleNum - 1];
  if (sample) triggerPreview(sampleNum - 1, sample, period);
}

/**
 * Audition the current sample at the keyboard-mapped pitch — used in the
 * sample view to preview without touching the song. No commit, no cursor
 * advance, no period write. Out-of-range notes (offsets that fall outside
 * PT's 3-octave table) silently no-op.
 */
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

/** Pattern view: write+audition. Sample view: audition only. */
export function onPianoKey(semitoneOffset: number): void {
  if (view() === "sample") previewSampleAtPitch(semitoneOffset);
  else enterNote(semitoneOffset);
}

/**
 * Auto-advance: right within the row, down on the last sub-field.
 *   sampleHi → sampleLo → (down)
 *   effectCmd → effectHi → effectLo → (down, then back to effectCmd)
 * The post-effectLo rewind matches the PT/FT2 three-digit effect rhythm.
 *
 * Sample numbers clamp to PT's 1..31 (5-bit field).
 */
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
    advanceByEditStep();
    // Skip the effectCmd rewind at edit step 0 — there we WANT the
    // cursor to stay on effectLo for chord-style overwrites.
    if (c.field === "effectLo" && editStep() > 0) {
      applyCursor({ ...cursor(), field: "effectCmd" });
    }
  }
}

export function clearAtCursor(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = cursor();
  const pat = s.patterns[s.orders[c.order] ?? -1];
  const note = pat?.rows[c.row]?.[c.channel];
  if (!note) return;
  const patch = clearFieldPatch(note, c.field);
  commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
  advanceByEditStep();
}

/**
 * Walk back up the cursor's channel for the most recent non-empty
 * effect, copy it to the cursor cell, advance. No-op when no prior
 * effect — silently writing zeros would be destructive on accidental key.
 */
export function repeatLastEffectFromAbove(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = cursor();
  const pat = s.patterns[s.orders[c.order] ?? -1];
  if (!pat) return;
  let copy: { effect: number; effectParam: number } | null = null;
  for (let r = c.row - 1; r >= 0; r--) {
    const cell = pat.rows[r]?.[c.channel];
    if (!cell) continue;
    if (cell.effect !== 0 || cell.effectParam !== 0) {
      copy = { effect: cell.effect, effectParam: cell.effectParam };
      break;
    }
  }
  if (!copy) return;
  const patch = copy;
  commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
  advanceByEditStep();
}

// ─── Range selection / clipboard ────────────────────────────────────────

/**
 * Cmd+A cycles three levels: (smaller / arbitrary) → whole channel →
 * whole pattern → no-op. The "exact rectangle" check means an arbitrary
 * drag-selection jumps straight to step 1 instead of expanding from it.
 * Row range clamps to the order's visible band so Dxx-truncated patterns
 * don't get a selection bleeding into the hidden tail.
 */
export function selectAllStep(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = cursor();
  const sel = selection();
  const { first, last } = visibleRows(c.order);
  const isWholePattern =
    !!sel &&
    sel.order === c.order &&
    sel.startRow === first &&
    sel.endRow === last &&
    sel.startChannel === 0 &&
    sel.endChannel === CHANNELS - 1;
  if (isWholePattern) return;
  const isWholeChannel =
    !!sel &&
    sel.order === c.order &&
    sel.startRow === first &&
    sel.endRow === last &&
    sel.startChannel === c.channel &&
    sel.endChannel === c.channel;
  if (isWholeChannel) {
    setSelection(makeSelection(c.order, first, 0, last, CHANNELS - 1));
    return;
  }
  setSelection(makeSelection(c.order, first, c.channel, last, c.channel));
}

/**
 * Sample-view counterpart of `selectAllStep`. Not gated on transport —
 * waveform selection doesn't mutate the song.
 */
export function selectAllSample(): void {
  const slot = currentSample() - 1;
  // Chiptune mode has no Crop/Cut/range-aware effects (the synth
  // re-renders on every param edit), so selection is inert there.
  if (getWorkbench(slot)?.source.kind === "chiptune") return;
  const s = song();
  const len = s?.samples[slot]?.data.length ?? 0;
  if (len < 2) return;
  setSampleSelection({ start: 0, end: len });
}

/** Selection if any, otherwise the cursor's single cell as a range. */
function rangeForClipboard(): PatternRange | null {
  if (!song()) return null;
  const sel = selection();
  if (sel)
    return {
      order: sel.order,
      startRow: sel.startRow,
      endRow: sel.endRow,
      startChannel: sel.startChannel,
      endChannel: sel.endChannel,
    };
  const c = cursor();
  return {
    order: c.order,
    startRow: c.row,
    endRow: c.row,
    startChannel: c.channel,
    endChannel: c.channel,
  };
}

export function copySelection(): void {
  const range = rangeForClipboard();
  if (!range) return;
  const s = song();
  if (!s) return;
  const slice = readSlice(s, range);
  if (!slice) return;
  setClipboardSlice({ rows: slice });
}

export function cutSelection(): void {
  const range = rangeForClipboard();
  if (!range) return;
  const s = song();
  if (!s) return;
  const slice = readSlice(s, range);
  if (!slice) return;
  setClipboardSlice({ rows: slice });
  commitEdit((song) => clearRange(song, range));
  setSelection(null);
}

/** Paste, then drop the cursor onto the row after the block so repeated
 *  pastes stack downward without manual stepping. */
export function pasteAtCursor(): void {
  if (transport() === "playing") return;
  const slice = clipboardSlice();
  if (!slice || slice.rows.length === 0) return;
  const c = cursor();
  commitEdit((song) => pasteSlice(song, slice.rows, c.order, c.row, c.channel));
  applyCursor(stepRowPageDown(c, slice.rows.length));
}

/**
 * Selection if any, otherwise the cursor cell as a one-cell range.
 * Selection is preserved so the user can chord ⇧- to walk a phrase down.
 * Empty cells stay empty; non-empty cells re-snap to PT's finetune-0 grid.
 */
export function transposeAtCursor(deltaSemitones: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = selection();
  const range =
    sel ??
    (() => {
      const c = cursor();
      return {
        order: c.order,
        startRow: c.row,
        endRow: c.row,
        startChannel: c.channel,
        endChannel: c.channel,
      };
    })();
  commitEdit((song) => transposeRange(song, range, deltaSemitones));
}

/**
 * With selection: clear it, leave cursor put. Without: delete the cell
 * above on this channel and pull up — text-editor Backspace.
 */
export function backspaceCell(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = selection();
  if (sel) {
    commitEdit((song) => clearRange(song, sel));
    return;
  }
  const c = cursor();
  if (c.row <= 0) return;
  commitEdit((song) => deleteCellPullUp(song, c.order, c.row - 1, c.channel));
  // Step explicitly to row-1, not via moveUp: the pull-up may have
  // shifted a Dxx into the cursor's row, hiding it; moveUp from a
  // hidden row would land *above* the closest visible. Backspace's
  // contract is "the cell I deleted moved up; follow it" → row-1.
  applyCursor({ ...c, row: c.row - 1 });
}

export function deleteSelection(): void {
  if (transport() === "playing") return;
  const sel = selection();
  if (!sel) return;
  commitEdit((song) => clearRange(song, sel));
}

/** Shift+Backspace: same shape as backspaceCell but spanning all channels. */
export function backspaceRow(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = selection();
  if (sel) {
    commitEdit((song) =>
      clearRange(song, {
        order: sel.order,
        startRow: sel.startRow,
        endRow: sel.endRow,
        startChannel: 0,
        endChannel: CHANNELS - 1,
      }),
    );
    return;
  }
  const c = cursor();
  if (c.row <= 0) return;
  commitEdit((song) => deleteRowPullUp(song, c.order, c.row - 1));
  // See `backspaceCell` for the explicit row-1 step (Dxx pull-up).
  applyCursor({ ...c, row: c.row - 1 });
}

export function insertEmptyCell(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = cursor();
  commitEdit((song) => insertCellPushDown(song, c.order, c.row, c.channel));
  advanceCursor();
}

/** Shift+Return: same shape as insertEmptyCell but spanning all channels. */
export function insertEmptyRow(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = cursor();
  commitEdit((song) => insertRowPushDown(song, c.order, c.row));
  advanceCursor();
}

// 0-based channel index. Mid-playback toggles are honoured per-tick.
export function toggleChannelMute(channel: number): void {
  toggleMute(channel);
}
export function toggleChannelSolo(channel: number): void {
  toggleSolo(channel);
}
