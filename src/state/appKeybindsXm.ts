/**
 * FT2-mode keyboard shortcuts. Sibling to `state/appKeybinds.ts` (PT2);
 * the global / format-agnostic shortcuts (Open / Save / view switch /
 * transport / undo / select-all / clipboard) stay registered there
 * unconditionally. This file registers the cursor-navigation, note,
 * hex/letter, clear, and backspace bindings — all gated on FT2 mode so
 * the PT2 set never fires when an XM song is loaded.
 */

import { registerShortcut } from "./shortcuts";
import { song, transport, xm2Song } from "./song";
import { view } from "./view";
import { toggleMute, toggleSolo } from "./channelMute";
import { rowsPerBeat, beatsPerBar } from "./gridConfig";
import {
  type XmCursor,
  XM_FIELDS,
  xmCursor,
  xmMoveDown,
  xmMoveLeft,
  xmMoveRight,
  xmMoveUp,
  xmPageDown,
  xmPageUp,
  xmTabNext,
  xmTabPrev,
} from "./cursorXm";
import {
  applyXmCursor,
  applyXmCursorWithSong,
  backspaceXmCell,
  backspaceXmRow,
  clearXmAtCursor,
  copyXmSelection,
  cutXmSelection,
  deleteXmSelection,
  enterXmEffectChar,
  enterXmHexDigit,
  enterXmKeyOff,
  extendXmSelection,
  insertEmptyXmCell,
  insertEmptyXmRow,
  onXmPianoKey,
  pasteXmAtCursor,
  repeatLastXmEffectFromAbove,
  selectAllXmStep,
  stepXmChannelLeft,
  stepXmChannelRight,
  stepXmRowDown,
  stepXmRowPageDown,
  stepXmRowPageUp,
  stepXmRowUp,
  transposeXmAtCursor,
} from "./xmPatternEdit";
import {
  nextXmInstrument,
  prevXmInstrument,
  selectXmInstrument,
  xmOctaveDown,
  xmOctaveUp,
} from "./xmEdit";
import { previewXmNote, stopXmPreview } from "./xmPreview";
import { stopEnginePreview } from "./playback";
import * as preview from "./preview";
import { bounceXmSelectionToInstrument } from "./xmSampleEdit";
import {
  deleteXmOrderSlot,
  duplicateXmCurrentPattern,
  insertXmOrderSlot,
  jumpXmNextOrder,
  jumpXmPrevOrder,
  newXmBlankPatternAtOrder,
  stepXmNextPattern,
  stepXmPrevPattern,
} from "./xmOrderEdit";
import type { XmSong } from "../core/xm/types";
import {
  DIGIT_QUICK_PICK as INSTRUMENT_QUICK,
  HEX_KEYS,
  PIANO_KEYS,
} from "./keybindHelpers";

const isFt2Mode = () => song()?.format === "FT2";

// Why: full FT2 effect-command alphabet. 0..9 + A..F are the base PT-shared
// codes (arpeggio…set speed); G..X are XM extensions (skipping I, J, M, N,
// O, Q, S, U, V, W which ft2-clone leaves unimplemented). Routed to
// `enterXmEffectChar` so the upper-nibble param tail (G..X) and the basic
// 0..F flow through the same code path on the effectCmd field.
const EFFECT_CMD_KEYS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "k",
  "l",
  "p",
  "r",
  "t",
  "x",
] as const;

// Why: hex-digit entry covers instHi/Lo, volHi/Lo, effectHi/Lo — NOT
// effectCmd. The effect-cmd field has its own EFFECT_CMD_KEYS loop, and
// shadowing it with a hex registration would silently no-op (enterXmHexDigit
// has no case for that field).
function isXmHexField(): boolean {
  const f = xmCursor().field;
  return f !== "note" && f !== "effectCmd";
}

/** True when the cursor's field is the effect-cmd column (accepts letters G..X). */
function isEffectCmdField(): boolean {
  return xmCursor().field === "effectCmd";
}

export function registerXmAppKeybinds(): Array<() => void> {
  const cleanups: Array<() => void> = [];

  // ─── Cursor navigation ───────────────────────────────────────────────
  const navStep = (mover: (c: XmCursor, s: XmSong) => XmCursor) => () =>
    applyXmCursorWithSong(mover);
  cleanups.push(
    registerShortcut({
      key: "arrowleft",
      description: "Cursor left",
      when: isFt2Mode,
      run: navStep(xmMoveLeft),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowright",
      description: "Cursor right",
      when: isFt2Mode,
      run: navStep(xmMoveRight),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowup",
      description: "Cursor up",
      when: isFt2Mode,
      run: navStep(xmMoveUp),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowdown",
      description: "Cursor down",
      when: isFt2Mode,
      run: navStep(xmMoveDown),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "tab",
      description: "Next channel",
      when: isFt2Mode,
      run: navStep(xmTabNext),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "tab",
      shift: true,
      description: "Previous channel",
      when: isFt2Mode,
      run: navStep(xmTabPrev),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pageup",
      description: "Page up",
      when: isFt2Mode,
      run: () =>
        applyXmCursorWithSong((c, s) =>
          xmPageUp(c, s, rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pagedown",
      description: "Page down",
      when: isFt2Mode,
      run: () =>
        applyXmCursorWithSong((c, s) =>
          xmPageDown(c, s, rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );

  // ─── Note entry ──────────────────────────────────────────────────────
  // Piano-row fires in two places: the pattern grid (cursor on the note
  // field → commit + audible preview) and the instrument view (any
  // cursor field → preview only). `onXmPianoKey` is the dispatcher.
  for (const [k, offset] of Object.entries(PIANO_KEYS)) {
    cleanups.push(
      registerShortcut({
        key: k,
        position: true,
        description: `Note (offset ${offset})`,
        when: () =>
          isFt2Mode() &&
          transport() !== "playing" &&
          (view() === "sample" || xmCursor().field === "note"),
        run: () => onXmPianoKey(offset),
        runUp: () => {
          stopEnginePreview();
          preview.stopPreview();
          // Also clear the XM live-preview record so a subsequent
          // slider drag doesn't morph against a no-longer-audible
          // voice — the user has released the key, the preview is
          // gone, drags should be silent until a fresh key press.
          stopXmPreview();
        },
      }),
    );
    // Shift+piano: preview-only, no commit. Mirrors PT2's piano preview
    // so the user can audition from any cursor field. Routes through the
    // adapter in xmPreview.ts that morphs an XM sample into the PT2
    // preview worklet's shape — fidelity is "good enough for an audition".
    cleanups.push(
      registerShortcut({
        key: k,
        position: true,
        shift: true,
        description: `Preview note (offset ${offset})`,
        when: () => isFt2Mode() && transport() !== "playing",
        run: () => previewXmNote(offset),
        runUp: () => {
          stopEnginePreview();
          preview.stopPreview();
          // Also clear the XM live-preview record so a subsequent
          // slider drag doesn't morph against a no-longer-audible
          // voice — the user has released the key, the preview is
          // gone, drags should be silent until a fresh key press.
          stopXmPreview();
        },
      }),
    );
  }
  // Backtick — XM key-off (note 97). Only on the note field, like piano.
  cleanups.push(
    registerShortcut({
      key: "`",
      position: true,
      description: "Key off (XM note 97)",
      when: () =>
        isFt2Mode() &&
        transport() !== "playing" &&
        view() !== "sample" &&
        xmCursor().field === "note",
      run: enterXmKeyOff,
    }),
  );

  // ─── Hex-digit entry ─────────────────────────────────────────────────
  // Same physical keys as piano (A..F overlap), but the `when` gate
  // routes by cursor field. Effect-cmd column accepts letters G..X via
  // the separate registration below.
  for (const [k, val] of Object.entries(HEX_KEYS)) {
    cleanups.push(
      registerShortcut({
        key: k,
        description: `Hex digit ${val.toString(16).toUpperCase()}`,
        when: () =>
          isFt2Mode() &&
          transport() !== "playing" &&
          view() !== "sample" &&
          isXmHexField(),
        run: () => enterXmHexDigit(val),
      }),
    );
  }
  // Effect-cmd characters: 0..9, A..F (PT-shared codes) + G..X (XM
  // extensions). Only fire when the cursor is exactly on the effect-cmd
  // field so they don't shadow piano keys or the hex-nibble loop above.
  for (const ch of EFFECT_CMD_KEYS) {
    cleanups.push(
      registerShortcut({
        key: ch,
        description: `Effect command ${ch.toUpperCase()}`,
        when: () =>
          isFt2Mode() &&
          transport() !== "playing" &&
          view() !== "sample" &&
          isEffectCmdField(),
        run: () => enterXmEffectChar(ch),
      }),
    );
  }

  // ─── Octave / instrument quick-pick ──────────────────────────────────
  cleanups.push(
    registerShortcut({
      key: "z",
      position: true,
      description: "Octave down",
      when: isFt2Mode,
      run: xmOctaveDown,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "x",
      position: true,
      description: "Octave up",
      when: isFt2Mode,
      run: xmOctaveUp,
    }),
  );
  for (const [k, n] of Object.entries(INSTRUMENT_QUICK)) {
    cleanups.push(
      registerShortcut({
        key: k,
        description: `Select instrument ${n}`,
        when: () =>
          isFt2Mode() &&
          transport() !== "playing" &&
          (view() === "sample" || xmCursor().field === "note"),
        run: () => selectXmInstrument(n),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: k,
        shift: true,
        description: `Select instrument ${n + 10}`,
        when: () => isFt2Mode() && transport() !== "playing",
        run: () => selectXmInstrument(n + 10),
      }),
    );
  }
  cleanups.push(
    registerShortcut({
      key: "arrowup",
      alt: true,
      description: "Previous instrument",
      when: () => isFt2Mode() && transport() !== "playing",
      run: prevXmInstrument,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowdown",
      alt: true,
      description: "Next instrument",
      when: () => isFt2Mode() && transport() !== "playing",
      run: nextXmInstrument,
    }),
  );

  // ─── Shift+arrow / page selection ────────────────────────────────────
  // Mirrors PT2: left/right hop a whole channel (the per-cell sub-fields
  // don't matter for a selection rectangle); up/down/page step rows.
  // All gated on FT2 + pattern view + transport idle.
  const selectionWhen = () =>
    isFt2Mode() && transport() !== "playing" && view() !== "sample";
  cleanups.push(
    registerShortcut({
      key: "arrowleft",
      shift: true,
      description: "Extend selection left",
      when: selectionWhen,
      run: () => extendXmSelection(stepXmChannelLeft(xmCursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowright",
      shift: true,
      description: "Extend selection right",
      when: selectionWhen,
      run: () => extendXmSelection(stepXmChannelRight(xmCursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowup",
      shift: true,
      description: "Extend selection up",
      when: selectionWhen,
      run: () => extendXmSelection(stepXmRowUp(xmCursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowdown",
      shift: true,
      description: "Extend selection down",
      when: selectionWhen,
      run: () => extendXmSelection(stepXmRowDown(xmCursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pageup",
      shift: true,
      description: "Extend selection by a page up",
      when: selectionWhen,
      run: () =>
        extendXmSelection(
          stepXmRowPageUp(xmCursor(), rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pagedown",
      shift: true,
      description: "Extend selection by a page down",
      when: selectionWhen,
      run: () =>
        extendXmSelection(
          stepXmRowPageDown(xmCursor(), rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  // Cmd+A — three-level cycle: cursor's channel → whole pattern → no-op.
  cleanups.push(
    registerShortcut({
      key: "a",
      mod: true,
      description: "Select all rows of channel / pattern",
      when: selectionWhen,
      run: selectAllXmStep,
    }),
  );
  // Delete — clear the selected range.
  cleanups.push(
    registerShortcut({
      key: "delete",
      description: "Clear selected range",
      when: () => isFt2Mode() && transport() !== "playing",
      run: deleteXmSelection,
    }),
  );

  // ─── Order list ──────────────────────────────────────────────────────
  // Mirrors PT2's bracket-key map exactly so muscle memory carries:
  //   [  / ]            → previous / next order in the song
  //   Shift + [ / ]     → previous / next pattern at the current slot
  //   ⌘ + ]             → insert a duplicate order slot
  //   ⌘ + [             → delete the order slot
  //   Option + [        → new blank pattern at the slot
  //   Option + ]        → duplicate the current pattern into a new slot
  cleanups.push(
    registerShortcut({
      key: "[",
      position: true,
      description: "Previous order in song",
      when: isFt2Mode,
      run: jumpXmPrevOrder,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      position: true,
      description: "Next order in song",
      when: isFt2Mode,
      run: jumpXmNextOrder,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      shift: true,
      position: true,
      description: "Previous pattern at slot",
      when: isFt2Mode,
      run: stepXmPrevPattern,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      shift: true,
      position: true,
      description: "Next pattern at slot",
      when: isFt2Mode,
      run: stepXmNextPattern,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      mod: true,
      position: true,
      description: "Insert order slot",
      when: isFt2Mode,
      run: insertXmOrderSlot,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      mod: true,
      position: true,
      description: "Delete order slot",
      when: isFt2Mode,
      run: deleteXmOrderSlot,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      alt: true,
      position: true,
      description: "New blank pattern at slot",
      when: isFt2Mode,
      run: newXmBlankPatternAtOrder,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      alt: true,
      position: true,
      description: "Duplicate pattern at slot",
      when: isFt2Mode,
      run: duplicateXmCurrentPattern,
    }),
  );

  // ─── Clear / backspace ───────────────────────────────────────────────
  cleanups.push(
    registerShortcut({
      key: ".",
      description: "Clear field under cursor",
      when: isFt2Mode,
      run: clearXmAtCursor,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "backspace",
      description: "Clear selection / clear cell, step up",
      when: isFt2Mode,
      run: backspaceXmCell,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "backspace",
      shift: true,
      description:
        "Clear selected rows / clear current row, step up (all channels)",
      when: isFt2Mode,
      run: backspaceXmRow,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "enter",
      description: "Insert empty cell (push channel down)",
      when: isFt2Mode,
      run: insertEmptyXmCell,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "enter",
      shift: true,
      description: "Insert empty row (push all channels down)",
      when: isFt2Mode,
      run: insertEmptyXmRow,
    }),
  );

  // ─── Per-channel mute / solo ─────────────────────────────────────────
  // Option+1..9, 0 → mute channels 1..10. Shift adds solo. The bare digit
  // is reserved for FT2 instrument quick-pick (registered above), so we
  // use Option as the modifier — matches PT's keybind precisely. Channels
  // 11..32 don't get a single-key shortcut (no digit row available); the
  // header buttons handle those.
  const muteDigits: Record<string, number> = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "0": 10,
  };
  // Skip the binding entirely when the FT2 song has fewer channels than
  // the digit refers to — pressing Option+9 on a 4-channel song shouldn't
  // toggle a non-existent channel.
  const channelExists = (channel: number) => {
    const s = xm2Song();
    return !!s && channel < s.channelCount;
  };
  for (const [k, n] of Object.entries(muteDigits)) {
    const channel = n - 1;
    cleanups.push(
      registerShortcut({
        key: k,
        alt: true,
        description: `Mute channel ${n}`,
        when: () => isFt2Mode() && channelExists(channel),
        run: () => toggleMute(channel),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: k,
        alt: true,
        shift: true,
        description: `Solo channel ${n}`,
        when: () => isFt2Mode() && channelExists(channel),
        run: () => toggleSolo(channel),
      }),
    );
  }

  // ─── Bounce selection to instrument ──────────────────────────────────
  // Cmd+E renders the current selection through the XM replayer into
  // the next free instrument slot. Mirrors PT2's "bounce to sample" but
  // produces an XM instrument with a single 16-bit sample.
  cleanups.push(
    registerShortcut({
      key: "e",
      mod: true,
      description: "Bounce selection to new instrument",
      when: () =>
        isFt2Mode() && transport() !== "playing" && view() !== "sample",
      run: bounceXmSelectionToInstrument,
    }),
  );

  // ─── Repeat last effect from above ───────────────────────────────────
  // Plain `,` (no modifier) walks back up the cursor's channel for the most
  // recent non-empty effect and copies it to the cursor cell. Pattern view
  // only — sample view shares the cursor signal but doesn't address a cell.
  cleanups.push(
    registerShortcut({
      key: ",",
      description: "Repeat last effect from above on this channel",
      when: () =>
        isFt2Mode() && transport() !== "playing" && view() !== "sample",
      run: repeatLastXmEffectFromAbove,
    }),
  );

  // ─── Transpose ───────────────────────────────────────────────────────
  // Layered onto the dash / equals keys with Shift to walk a phrase up or
  // down; Cmd extends the step from semitone to octave. Operates on the
  // selection when one exists, otherwise on the cell at the cursor —
  // mirrors PT2's behaviour exactly.
  const transposeWhen = () =>
    isFt2Mode() && transport() !== "playing" && view() !== "sample";
  cleanups.push(
    registerShortcut({
      key: "-",
      shift: true,
      description: "Transpose down 1 semitone",
      when: transposeWhen,
      run: () => transposeXmAtCursor(-1),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "=",
      shift: true,
      description: "Transpose up 1 semitone",
      when: transposeWhen,
      run: () => transposeXmAtCursor(1),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "-",
      mod: true,
      shift: true,
      description: "Transpose down 1 octave",
      when: transposeWhen,
      run: () => transposeXmAtCursor(-12),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "=",
      mod: true,
      shift: true,
      description: "Transpose up 1 octave",
      when: transposeWhen,
      run: () => transposeXmAtCursor(12),
    }),
  );

  void XM_FIELDS;
  return cleanups;
}
