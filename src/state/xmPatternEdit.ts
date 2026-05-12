/**
 * FT2-mode pattern editing — sibling to `state/patternEdit.ts` (PT2).
 * Cursor movement primitives live in `state/cursorXm.ts`; this module
 * commits content edits (note entry, hex/letter entry, clear, backspace)
 * through `commitEditXm`.
 *
 * The editing model differs from PT in three places:
 *   - 8 sub-fields per cell (note, instHi/Lo, volHi/Lo, effectCmd/Hi/Lo)
 *   - effectCmd accepts 0..F **and** letters G..X (XM extends past 0x10)
 *   - volume column is one byte where the high nibble selects a kind
 *     (set-volume, slide, vibrato, panning, …) and the low nibble is its
 *     magnitude. Both nibbles are independently editable.
 */

import {
  clearXmRange,
  pasteXmSlice,
  readXmSlice,
  type XmPatternRange,
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
import { rowsOfPattern } from "../core/song";
import {
  type XmCursor,
  XM_FIELDS,
  xmCursor,
  xmMoveDown,
  xmMoveRight,
  setXmCursor,
} from "./cursorXm";
import { xmClipboardSlice, setXmClipboardSlice } from "./clipboard";
import { editStep } from "./edit";
import { commitEditXm, transport, xm2Song as song } from "./song";
import { setPlayPos } from "./song";
import { view } from "./view";
import { previewXmNote } from "./xmPreview";
import {
  clearXmFieldPatch,
  currentXmInstrument,
  currentXmOctave,
} from "./xmEdit";
import {
  clearXmSelection,
  makeSelection,
  setXmSelection,
  setXmSelectionAnchor,
  xmSelection,
  xmSelectionAnchor,
} from "./selection";

/**
 * Commit a cursor move. Drops range selection AND its anchor — once
 * the user starts navigating with arrows / clicks, the highlighted
 * rectangle is stale. Shift-arrow / drag go through `extendXmSelection`
 * instead. Updates `playPos` so the visible playhead tracks the user's
 * edit position, mirroring PT2's `applyCursor`.
 */
export function applyXmCursor(next: XmCursor): void {
  if (transport() === "playing") return;
  setXmCursor(next);
  setPlayPos({ order: next.order, row: next.row });
  clearXmSelection();
}

/**
 * Shift+arrow / shift+drag entry: re-anchor at the cursor's PRE-MOVE
 * position on the first call after a plain navigation, then update the
 * selection rectangle. Cross-order moves drop the rectangle and
 * re-anchor at the new order — selection is single-pattern, same as PT.
 */
export function extendXmSelection(next: XmCursor): void {
  if (transport() === "playing") return;
  const before = xmCursor();
  let anchor = xmSelectionAnchor();
  if (!anchor) {
    anchor = {
      order: before.order,
      row: before.row,
      channel: before.channel,
    };
    setXmSelectionAnchor(anchor);
  }
  setXmCursor(next);
  setPlayPos({ order: next.order, row: next.row });
  if (next.order !== anchor.order) {
    const reAnchor = {
      order: next.order,
      row: next.row,
      channel: next.channel,
    };
    setXmSelectionAnchor(reAnchor);
    setXmSelection(null);
    return;
  }
  setXmSelection(
    makeSelection(
      anchor.order,
      anchor.row,
      anchor.channel,
      next.row,
      next.channel,
    ),
  );
}

/** Variant for movement functions that need the song to compute the next cursor. */
export function applyXmCursorWithSong(
  fn: (c: XmCursor, s: NonNullable<ReturnType<typeof song>>) => XmCursor,
): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  applyXmCursor(fn(xmCursor(), s));
}

/** Advance by `editStep()` rows after a content edit. Step 0 keeps the
 *  cursor put — useful for stamping chords on the same cell. */
function advanceByEditStep(): void {
  const s = song();
  if (!s) return;
  const step = editStep();
  if (step <= 0) return;
  let next = xmCursor();
  for (let i = 0; i < step; i++) next = xmMoveDown(next, s);
  applyXmCursor(next);
}

// ─── Note entry ─────────────────────────────────────────────────────────

/**
 * Convert a piano-key semitone offset into an XM 1-based note number
 * (1..96 = C-0..B-7). Returns null for out-of-range. The piano-row
 * keymap covers two octaves' worth of offsets (0..16) on top of the
 * `currentXmOctave` base.
 */
function noteForOffset(offset: number): number | null {
  const base = currentXmOctave() * 12; // C of the current octave (0-based)
  const note = base + offset + 1; // XM note numbers are 1-based
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
  advanceByEditStep();
  // Audibly preview the note the user just typed — mirrors PT2's
  // enterNote, which also triggers a preview after the commit. The
  // preview adapter handles the XM-sample → PT-preview-worklet
  // conversion (see xmPreview.ts).
  previewXmNote(semitoneOffset);
}

/**
 * Piano-key dispatcher: in the pattern view this commits a note to the
 * cursor's cell (and previews); in the instrument view it only
 * previews. Mirrors PT2's `onPianoKey`.
 */
export function onXmPianoKey(semitoneOffset: number): void {
  if (view() === "sample") previewXmNote(semitoneOffset);
  else enterXmNote(semitoneOffset);
}

/**
 * Write the XM key-off marker (note 97 — `==.` in the grid). Bound to a
 * dedicated key (typically backtick / capslock) rather than a piano-row
 * key so it can't be triggered by a misfired note.
 */
export function enterXmKeyOff(): void {
  if (transport() === "playing") return;
  const c = xmCursor();
  if (c.field !== "note") return;
  commitEditXm((s) => setXmCell(s, c.order, c.row, c.channel, { note: 97 }));
  advanceByEditStep();
}

// ─── Hex / letter entry ─────────────────────────────────────────────────

/**
 * Hex-digit entry into one of the nibble fields (instHi/Lo, volHi/Lo,
 * effectHi/Lo). For `effectCmd` use `enterXmEffectChar` instead — the
 * effect column accepts letters G..X for XM's extended commands.
 *
 * Auto-advance pattern matches PT2:
 *   instHi → instLo → (down by editStep)
 *   volHi → volLo → (down by editStep)
 *   effectHi → effectLo → (down, rewind to effectCmd at step > 0)
 */
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
      // XM instruments are 1..128; cap so a wild high nibble can't push
      // past the slot range.
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
      // The low nibble of the volume column is the "magnitude" half;
      // patching only the high nibble preserves the user's existing
      // magnitude. Empty (high=0) cells reset the column entirely.
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
    advanceByEditStep();
    if (stepsRewind && editStep() > 0) {
      // Rewind to effectCmd so the next typed effect starts cleanly,
      // mirroring PT2's three-digit effect rhythm.
      const idx = XM_FIELDS.indexOf("effectCmd");
      applyXmCursor({ ...xmCursor(), field: XM_FIELDS[idx]! });
    }
  }
}

/**
 * Effect-command entry. Accepts hex digits 0..F **and** letters G..X for
 * XM's extended commands (G=global vol, K=key off, P=pan slide, T=tremor,
 * X=X-extended, …). Anything else is a no-op so a stray keystroke can't
 * write garbage. Auto-advances to `effectHi`.
 */
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

// ─── Clear / backspace ─────────────────────────────────────────────────

/** `.` — clear the field under the cursor. */
export function clearXmAtCursor(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  const pat = s.patterns[s.orders[c.order] ?? -1];
  const cell = pat?.rows[c.row]?.[c.channel];
  if (!cell) return;
  const patch = clearXmFieldPatch(cell, c.field);
  commitEditXm((s) => setXmCell(s, c.order, c.row, c.channel, patch));
  advanceByEditStep();
}

/**
 * Resize the pattern at the cursor's order slot to `rowCount` rows.
 * Growing pads the tail with empty rows; shrinking drops them. The
 * cursor row clamps to the new last row when shrinking, so the user's
 * focus doesn't escape the pattern bounds.
 */
export function setXmRowCountAtCursor(rowCount: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  const patternIndex = s.orders[c.order];
  if (patternIndex === undefined) return;
  commitEditXm((s) => setXmPatternRowCount(s, patternIndex, rowCount));
  // After the commit, clamp the cursor row to the new bound.
  const after = song();
  if (!after) return;
  const newRows = after.patterns[patternIndex]?.rowCount ?? 0;
  if (c.row >= newRows && newRows > 0) {
    applyXmCursor({ ...c, row: newRows - 1 });
  }
}

/**
 * Set the song-wide channel count. Patterns are widened (empty cells
 * appended) or trimmed (tail channels dropped). Clamps the cursor's
 * channel to the new last column when shrinking past it.
 */
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

/**
 * With selection: clear it, leave the cursor put. Without: delete the
 * cell above on this channel and pull the rest of the channel up by one
 * row — text-editor Backspace. Mirrors PT2's `backspaceCell`.
 */
export function backspaceXmCell(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = xmSelection();
  if (sel) {
    commitEditXm((s) => clearXmRange(s, sel));
    return;
  }
  const c = xmCursor();
  if (c.row <= 0) return;
  commitEditXm((s) => deleteXmCellPullUp(s, c.order, c.row - 1, c.channel));
  applyXmCursor({ ...c, row: c.row - 1 });
}

/**
 * Shift+Backspace — same shape as `backspaceXmCell` but spanning all
 * channels. With a selection, clears every channel within the selected
 * rows; without, pulls the entire row above the cursor up by one across
 * every channel.
 */
export function backspaceXmRow(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = xmSelection();
  if (sel) {
    commitEditXm((song) =>
      clearXmRange(song, {
        order: sel.order,
        startRow: sel.startRow,
        endRow: sel.endRow,
        startChannel: 0,
        endChannel: song.channelCount - 1,
      }),
    );
    return;
  }
  const c = xmCursor();
  if (c.row <= 0) return;
  commitEditXm((s) => deleteXmRowPullUp(s, c.order, c.row - 1));
  applyXmCursor({ ...c, row: c.row - 1 });
}

/**
 * Enter — push the cursor's cell (and everything below it on this
 * channel) down by one row, dropping an empty cell at the cursor.
 * Cursor then steps one row down so the user can keep entering notes.
 */
export function insertEmptyXmCell(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  commitEditXm((s) => insertXmCellPushDown(s, c.order, c.row, c.channel));
  applyXmCursor(stepXmRowDown(c));
}

/** Shift+Enter — same as `insertEmptyXmCell` but spanning all channels. */
export function insertEmptyXmRow(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  commitEditXm((s) => insertXmRowPushDown(s, c.order, c.row));
  applyXmCursor(stepXmRowDown(c));
}

// ─── Selection step helpers ─────────────────────────────────────────────
// Used by Shift+arrow / Shift+page extensions. Move a whole channel
// (skipping per-cell sub-fields, irrelevant for a selection rectangle).
// Row movement clamps to the cursor's pattern bounds.

function visibleRowsOfCursor(): { first: number; last: number } {
  const s = song();
  if (!s) return { first: 0, last: 0 };
  const c = xmCursor();
  const patIdx = s.orders[c.order];
  if (patIdx === undefined) return { first: 0, last: 0 };
  return { first: 0, last: rowsOfPattern(s, patIdx) - 1 };
}

export function stepXmChannelLeft(c: XmCursor): XmCursor {
  return { ...c, channel: Math.max(0, c.channel - 1) };
}
export function stepXmChannelRight(c: XmCursor): XmCursor {
  const s = song();
  const max = (s?.channelCount ?? 1) - 1;
  return { ...c, channel: Math.min(max, c.channel + 1) };
}
export function stepXmRowUp(c: XmCursor): XmCursor {
  return { ...c, row: Math.max(visibleRowsOfCursor().first, c.row - 1) };
}
export function stepXmRowDown(c: XmCursor): XmCursor {
  return { ...c, row: Math.min(visibleRowsOfCursor().last, c.row + 1) };
}
export function stepXmRowPageUp(c: XmCursor, n: number): XmCursor {
  return {
    ...c,
    row: Math.max(visibleRowsOfCursor().first, c.row - Math.max(1, n)),
  };
}
export function stepXmRowPageDown(c: XmCursor, n: number): XmCursor {
  return {
    ...c,
    row: Math.min(visibleRowsOfCursor().last, c.row + Math.max(1, n)),
  };
}

// ─── Range selection / clipboard ────────────────────────────────────────

/**
 * Cmd+A — three-level cycle (cursor's channel → whole pattern → no-op),
 * mirroring PT's `selectAllStep`. The "exact-rectangle" check means an
 * arbitrary drag-selection jumps straight to the channel level instead
 * of expanding from it.
 */
export function selectAllXmStep(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
  const sel = xmSelection();
  const { first, last } = visibleRowsOfCursor();
  const isWholePattern =
    !!sel &&
    sel.order === c.order &&
    sel.startRow === first &&
    sel.endRow === last &&
    sel.startChannel === 0 &&
    sel.endChannel === s.channelCount - 1;
  if (isWholePattern) return;
  const isWholeChannel =
    !!sel &&
    sel.order === c.order &&
    sel.startRow === first &&
    sel.endRow === last &&
    sel.startChannel === c.channel &&
    sel.endChannel === c.channel;
  if (isWholeChannel) {
    setXmSelection(makeSelection(c.order, first, 0, last, s.channelCount - 1));
    return;
  }
  setXmSelection(makeSelection(c.order, first, c.channel, last, c.channel));
}

/** Selection if any, otherwise the cursor's single cell as a range. */
function rangeForXmClipboard(): XmPatternRange | null {
  if (!song()) return null;
  const sel = xmSelection();
  if (sel)
    return {
      order: sel.order,
      startRow: sel.startRow,
      endRow: sel.endRow,
      startChannel: sel.startChannel,
      endChannel: sel.endChannel,
    };
  const c = xmCursor();
  return {
    order: c.order,
    startRow: c.row,
    endRow: c.row,
    startChannel: c.channel,
    endChannel: c.channel,
  };
}

export function copyXmSelection(): void {
  const range = rangeForXmClipboard();
  if (!range) return;
  const s = song();
  if (!s) return;
  const slice = readXmSlice(s, range);
  if (!slice) return;
  setXmClipboardSlice({ rows: slice });
}

export function cutXmSelection(): void {
  const range = rangeForXmClipboard();
  if (!range) return;
  const s = song();
  if (!s) return;
  const slice = readXmSlice(s, range);
  if (!slice) return;
  setXmClipboardSlice({ rows: slice });
  commitEditXm((s) => clearXmRange(s, range));
  setXmSelection(null);
}

/** Paste, then drop the cursor onto the row after the block so repeated
 *  pastes stack downward — mirrors PT's pasteAtCursor. */
export function pasteXmAtCursor(): void {
  if (transport() === "playing") return;
  const slice = xmClipboardSlice();
  if (!slice || slice.rows.length === 0) return;
  const c = xmCursor();
  commitEditXm((s) => pasteXmSlice(s, slice.rows, c.order, c.row, c.channel));
  applyXmCursor(stepXmRowPageDown(c, slice.rows.length));
}

/**
 * Walk back up the cursor's channel for the most recent non-empty
 * effect, copy it to the cursor cell, advance. No-op when no prior
 * effect — silently writing zeros would be destructive on accidental key.
 * Format-agnostic logic; XmNote happens to share `effect` / `effectParam`
 * field names with the PT2 Note.
 */
export function repeatLastXmEffectFromAbove(): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const c = xmCursor();
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
  commitEditXm((s) => setXmCell(s, c.order, c.row, c.channel, patch));
  advanceByEditStep();
}

/**
 * Selection if any, otherwise the cursor cell as a one-cell range.
 * Mirrors PT2's `transposeAtCursor` so the user can chord ⇧- / ⇧= to
 * walk a phrase up or down. Empty cells and key-off stay as they are;
 * non-empty notes clamp at the 1..96 XM range.
 */
export function transposeXmAtCursor(deltaSemitones: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  const sel = xmSelection();
  const range =
    sel ??
    (() => {
      const c = xmCursor();
      return {
        order: c.order,
        startRow: c.row,
        endRow: c.row,
        startChannel: c.channel,
        endChannel: c.channel,
      };
    })();
  commitEditXm((s) => transposeRangeXm(s, range, deltaSemitones));
}

/**
 * With selection: clear it, leave cursor put. Without: no-op (FT2
 * Backspace handles single-cell delete via `backspaceXmCell`).
 */
export function deleteXmSelection(): void {
  if (transport() === "playing") return;
  const sel = xmSelection();
  if (!sel) return;
  commitEditXm((s) => clearXmRange(s, sel));
}
