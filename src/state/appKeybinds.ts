import { registerShortcut } from "./shortcuts";
import {
  cursor,
  isHexField,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  pageDown,
  pageUp,
  tabNext,
  tabPrev,
  type Cursor,
} from "./cursor";
import { transport } from "./song";
import { setView, view } from "./view";
import { togglePaulaModel } from "./settings";
import { rowsPerBeat, beatsPerBar } from "./gridConfig";
import {
  decEditStep,
  incEditStep,
  resetEditStep,
  octaveDown,
  octaveUp,
  selectSample,
  nextSample,
  prevSample,
} from "./edit";
import {
  stopPlayback,
  playFromStart,
  playFromCursor,
  playPatternFromStart,
  playPatternFromCursor,
  stopEnginePreview,
} from "./playback";
import * as preview from "./preview";
import type { Song } from "../core/mod/types";

/**
 * Piano-row key mapping → semitone offset from the current octave's C.
 *   row 1 (white keys A S D F G H J K L ;)  + row 0 sharps (W E   T Y U   O P)
 */
const PIANO_KEYS: Readonly<Record<string, number>> = {
  a: 0, // C
  w: 1, // C#
  s: 2, // D
  e: 3, // D#
  d: 4, // E
  f: 5, // F
  t: 6, // F#
  g: 7, // G
  y: 8, // G#
  h: 9, // A
  u: 10, // A#
  j: 11, // B
  k: 12, // C +1 octave
  o: 13, // C# +1
  l: 14, // D +1
  p: 15, // D# +1
  ";": 16, // E +1
};

const HEX_KEYS: Readonly<Record<string, number>> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  a: 10,
  b: 11,
  c: 12,
  d: 13,
  e: 14,
  f: 15,
};

const SAMPLE_QUICK: Readonly<Record<string, number>> = {
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

/**
 * Closures the App component owns — they read App-local signals (selection,
 * filename, current sample workbench, etc.) that don't belong on the
 * module-level state. Passed in once at mount.
 */
export interface AppKeybindHandlers {
  openFilePicker: () => void;
  saveProject: () => void;
  selectAllStep: () => void;
  /**
   * Sample-view counterpart of `selectAllStep`. Sets the waveform selection
   * to the full int8 range of the current sample. No-op when the slot is
   * empty. Bound to Cmd+A while `view() === "sample"`.
   */
  selectAllSample: () => void;
  copySelection: () => void;
  cutSelection: () => void;
  pasteAtCursor: () => void;
  bounceSelectionToSample: () => void;
  applyCursor: (next: Cursor) => void;
  applyCursorWithSong: (mover: (c: Cursor, s: Song) => Cursor) => void;
  extendSelection: (next: Cursor) => void;
  stepChannelLeft: (c: Cursor) => Cursor;
  stepChannelRight: (c: Cursor) => Cursor;
  stepRowUp: (c: Cursor) => Cursor;
  stepRowDown: (c: Cursor) => Cursor;
  stepRowPageUp: (c: Cursor, n: number) => Cursor;
  stepRowPageDown: (c: Cursor, n: number) => Cursor;
  onPianoKey: (offset: number) => void;
  /**
   * Audition the current sample at the keyboard-mapped pitch without writing
   * to the song. Bound to Shift+piano-row keys in pattern view so the user
   * can preview a note before deciding to commit it.
   */
  previewPianoKey: (offset: number) => void;
  enterHexDigit: (digit: number) => void;
  transposeAtCursor: (delta: number) => void;
  repeatLastEffectFromAbove: () => void;
  stepPrevPattern: () => void;
  stepNextPattern: () => void;
  insertOrderSlot: () => void;
  deleteOrderSlot: () => void;
  newBlankPatternAtOrder: () => void;
  duplicateCurrentPattern: () => void;
  clearAtCursor: () => void;
  backspaceCell: () => void;
  backspaceRow: () => void;
  deleteSelection: () => void;
  insertEmptyCell: () => void;
  insertEmptyRow: () => void;
  toggleChannelMute: (channel: number) => void;
  toggleChannelSolo: (channel: number) => void;
}

/**
 * Register every global keyboard shortcut the App reacts to. Returns the
 * array of cleanup functions (one per registered shortcut) so the caller
 * can dispose them on unmount.
 *
 * Pulled out of App.tsx so the keybind table reads as a flat list rather
 * than 540 lines buried inside the component's onMount.
 */
export function registerAppKeybinds(h: AppKeybindHandlers): Array<() => void> {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    registerShortcut({
      key: "o",
      mod: true,
      description: "Open project / .mod",
      run: h.openFilePicker,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "s",
      mod: true,
      description: "Save project (.retro)",
      run: h.saveProject,
    }),
  );
  // Range selection / clipboard. Pattern view only — sample view has its
  // own clipboard story (none yet). All four are gated on transport so
  // mid-playback presses don't desync the on-screen song from the worklet.
  cleanups.push(
    registerShortcut({
      key: "a",
      mod: true,
      description: "Select all rows of channel / pattern",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.selectAllStep,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "a",
      mod: true,
      description: "Select the whole waveform",
      when: () => view() === "sample",
      run: h.selectAllSample,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "c",
      mod: true,
      description: "Copy selection to clipboard",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.copySelection,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "x",
      mod: true,
      description: "Cut selection to clipboard",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.cutSelection,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "v",
      mod: true,
      description: "Paste clipboard at cursor",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.pasteAtCursor,
    }),
  );
  // Cmd+E — render the current selection through the clean offline mixer
  // and land it in the next free sample slot. The handler itself bails on
  // missing-selection / no-free-slot, so the gate here just covers playback
  // and view; finer eligibility is the handler's concern.
  cleanups.push(
    registerShortcut({
      key: "e",
      mod: true,
      description: "Bounce selection to sample",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.bounceSelectionToSample,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "f2",
      description: "Pattern view",
      run: () => setView("pattern"),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "f3",
      description: "Sample view",
      run: () => setView("sample"),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "f4",
      description: "Info view",
      run: () => setView("info"),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "f5",
      description: "Settings view",
      run: () => setView("settings"),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "a",
      mod: true,
      shift: true,
      description: "Toggle Paula filter model (A1200 / A500)",
      run: togglePaulaModel,
    }),
  );
  // Transport (Space-based chords; Option used instead of Cmd to avoid the
  // macOS Spotlight conflict on ⌘+Space).
  //   Space               → toggle: stop if playing, otherwise play song from start
  //   Option + Space      → play pattern (loop) from start of cursor's pattern
  //   Shift + Space       → play song from cursor
  //   Option + Shift + Space → play pattern (loop) from cursor row
  cleanups.push(
    registerShortcut({
      key: " ",
      description: "Play / Stop",
      run: () => {
        if (transport() === "playing") stopPlayback();
        else void playFromStart();
      },
    }),
  );
  cleanups.push(
    registerShortcut({
      key: " ",
      alt: true,
      description: "Play pattern (loop)",
      run: () => {
        void playPatternFromStart();
      },
    }),
  );
  cleanups.push(
    registerShortcut({
      key: " ",
      shift: true,
      description: "Play song from cursor",
      run: () => {
        void playFromCursor();
      },
    }),
  );
  cleanups.push(
    registerShortcut({
      key: " ",
      alt: true,
      shift: true,
      description: "Play pattern from cursor (loop)",
      run: () => {
        void playPatternFromCursor();
      },
    }),
  );
  // Cursor navigation (no-op while playing — handled inside applyCursor)
  cleanups.push(
    registerShortcut({
      key: "arrowleft",
      description: "Cursor left",
      run: () => h.applyCursor(moveLeft(cursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowright",
      description: "Cursor right",
      run: () => h.applyCursor(moveRight(cursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowup",
      description: "Cursor up",
      run: () => h.applyCursorWithSong(moveUp),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowdown",
      description: "Cursor down",
      run: () => h.applyCursorWithSong(moveDown),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "tab",
      description: "Next channel",
      run: () => h.applyCursor(tabNext(cursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "tab",
      shift: true,
      description: "Previous channel",
      run: () => h.applyCursor(tabPrev(cursor())),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pageup",
      description: "Page up",
      run: () =>
        h.applyCursorWithSong((c, s) =>
          pageUp(c, s, rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pagedown",
      description: "Page down",
      run: () =>
        h.applyCursorWithSong((c, s) =>
          pageDown(c, s, rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  // Shift+arrow: extend the range selection. Left/right hop a whole
  // channel (skipping per-cell sub-fields, which are irrelevant for
  // selection rectangles); up/down/page step rows. All gated to pattern
  // view — the cursor signal is shared with sample view but doesn't
  // address a pattern cell there.
  const shiftNav = (mover: (c: Cursor) => Cursor) => () =>
    h.extendSelection(mover(cursor()));
  cleanups.push(
    registerShortcut({
      key: "arrowleft",
      shift: true,
      description: "Extend selection left",
      when: () => transport() !== "playing" && view() !== "sample",
      run: shiftNav(h.stepChannelLeft),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowright",
      shift: true,
      description: "Extend selection right",
      when: () => transport() !== "playing" && view() !== "sample",
      run: shiftNav(h.stepChannelRight),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowup",
      shift: true,
      description: "Extend selection up",
      when: () => transport() !== "playing" && view() !== "sample",
      run: shiftNav(h.stepRowUp),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "arrowdown",
      shift: true,
      description: "Extend selection down",
      when: () => transport() !== "playing" && view() !== "sample",
      run: shiftNav(h.stepRowDown),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pageup",
      shift: true,
      description: "Extend selection by a page up",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () =>
        h.extendSelection(
          h.stepRowPageUp(cursor(), rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "pagedown",
      shift: true,
      description: "Extend selection by a page down",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () =>
        h.extendSelection(
          h.stepRowPageDown(cursor(), rowsPerBeat() * beatsPerBar()),
        ),
    }),
  );
  // Note entry — piano-row keys when the cursor is on the note field.
  // `runUp` stops the audition preview when the key is released, so held
  // notes (especially looping samples) don't keep ringing forever.
  //
  // The `when` gate matters because A/D/E/F (and others) double as hex
  // digits when the cursor is on a hex-editable field; without it, the
  // piano shortcut would shadow the hex shortcut on those overlapping keys.
  for (const [k, offset] of Object.entries(PIANO_KEYS)) {
    cleanups.push(
      registerShortcut({
        key: k,
        // Position-based: match by physical key (`event.code`), not the
        // produced letter. AZERTY / Dvorak / Colemak users get the same
        // home-row + black-key-row ergonomics as QWERTY because they're
        // pressing the same physical positions even though their keycap
        // labels differ. The piano `when` gate still routes to hex-digit
        // entry on hex fields — those shortcuts stay character-based.
        position: true,
        description: `Note (offset ${offset})`,
        // Pattern view: only fire on the note field (so A/D/E/F can act as
        // hex digits when the cursor is on a sample / effect nibble).
        // Sample view: always fire (cursor field is irrelevant when we're
        // just auditioning the current slot).
        when: () =>
          transport() !== "playing" &&
          (view() === "sample" || cursor().field === "note"),
        run: () => h.onPianoKey(offset),
        runUp: () => {
          stopEnginePreview();
          preview.stopPreview();
        },
      }),
    );
    // Shift+piano: preview-only, no commit. Mirrors sample view's piano
    // behaviour so the user can audition a note from anywhere in the
    // pattern grid (any cursor field) before deciding to type it for real.
    cleanups.push(
      registerShortcut({
        key: k,
        position: true,
        shift: true,
        description: `Preview note (offset ${offset})`,
        when: () => transport() !== "playing",
        run: () => h.previewPianoKey(offset),
        runUp: () => {
          stopEnginePreview();
          preview.stopPreview();
        },
      }),
    );
  }
  // Hex-digit entry — fills sample/effect nibbles. Same physical keys as
  // the piano-row letters (A..F) but the `when` gate routes by cursor field.
  // Pattern-view-only: in sample view the cursor is dormant, and digits should
  // flow to the sample-select shortcut instead of editing a hidden cell.
  for (const [k, val] of Object.entries(HEX_KEYS)) {
    cleanups.push(
      registerShortcut({
        key: k,
        description: `Hex digit ${val.toString(16).toUpperCase()}`,
        when: () =>
          transport() !== "playing" &&
          view() !== "sample" &&
          isHexField(cursor().field),
        run: () => h.enterHexDigit(val),
      }),
    );
  }
  cleanups.push(
    registerShortcut({
      key: "z",
      position: true,
      description: "Octave down",
      run: octaveDown,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "x",
      position: true,
      description: "Octave up",
      run: octaveUp,
    }),
  );
  // Edit step adjust — `<` / `>` (Shift+, / Shift+.), reset on `/`.
  // All position-mapped to the QWERTY-comma / -period / -slash physical
  // keys so non-QWERTY users hit the same physical positions regardless
  // of what character their layout produces there. Plain `[` / `]` now
  // mean "previous / next pattern at the cursor's order slot" — see
  // the order-list block lower down.
  cleanups.push(
    registerShortcut({
      key: ",",
      shift: true,
      position: true,
      description: "Decrease edit step",
      when: () => transport() !== "playing",
      run: decEditStep,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: ".",
      shift: true,
      position: true,
      description: "Increase edit step",
      when: () => transport() !== "playing",
      run: incEditStep,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "/",
      position: true,
      description: "Reset edit step to 1",
      when: () => transport() !== "playing",
      run: resetEditStep,
    }),
  );
  // Sample quick-select.
  //   1..9, 0          → samples 1..10 (in pattern view: only when cursor is
  //                      on the note field — hex fields swallow plain digits;
  //                      in sample view: always, since the cursor is dormant)
  //   Shift+1..9, 0    → samples 11..20 (always; hex entry doesn't use shift)
  //   -, =             → previous / next sample
  // Focused text inputs / selects are protected upstream by `installShortcuts`,
  // so typing into a sample-name field or a Target-note dropdown still works.
  for (const [k, n] of Object.entries(SAMPLE_QUICK)) {
    cleanups.push(
      registerShortcut({
        key: k,
        description: `Select sample ${n}`,
        when: () =>
          transport() !== "playing" &&
          (view() === "sample" || !isHexField(cursor().field)),
        run: () => selectSample(n),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: k,
        shift: true,
        description: `Select sample ${n + 10}`,
        when: () => transport() !== "playing",
        run: () => selectSample(n + 10),
      }),
    );
  }
  cleanups.push(
    registerShortcut({
      key: "-",
      description: "Previous sample",
      when: () => transport() !== "playing",
      run: prevSample,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "=",
      description: "Next sample",
      when: () => transport() !== "playing",
      run: nextSample,
    }),
  );
  // Transpose. Layered onto the prev/next sample shortcuts: Shift turns
  // sample-cycling into note-cycling, Cmd extends the step from semitone
  // to octave. Operates on the selection when one exists, otherwise on
  // the cell at the cursor — same scope rule as copy/paste.
  cleanups.push(
    registerShortcut({
      key: "-",
      shift: true,
      description: "Transpose down 1 semitone",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () => h.transposeAtCursor(-1),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "=",
      shift: true,
      description: "Transpose up 1 semitone",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () => h.transposeAtCursor(1),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "-",
      mod: true,
      shift: true,
      description: "Transpose down 1 octave",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () => h.transposeAtCursor(-12),
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "=",
      mod: true,
      shift: true,
      description: "Transpose up 1 octave",
      when: () => transport() !== "playing" && view() !== "sample",
      run: () => h.transposeAtCursor(12),
    }),
  );
  // Order list / pattern at slot. Everything is on the bracket pair so the
  // user only needs to remember one physical key region:
  //   [  / ]                 → previous / next pattern at the cursor's slot
  //   Cmd + ]                → insert a new order slot at the cursor
  //   Cmd + [                → delete the order slot at the cursor
  //   Option + [             → assign a fresh empty pattern to the slot
  //   Option + ]             → duplicate current pattern into a new slot
  // Option avoids the Cmd+Shift+[/] browser collision (next/prev tab on most
  // platforms) and Mac's Option-composed characters don't fight the matcher
  // since position mode reads event.code, not event.key.
  // All position-mapped to the QWERTY-bracket physical positions so e.g.
  // a Nordic user pressing the `å` / `¨` keys (which sit where `[` / `]`
  // sit on US) hits the same bindings.
  //
  // Plain `,` is "repeat last effect from above on this channel" —
  // pattern-view only, since the cursor signal is shared with sample view
  // but doesn't address a pattern cell there.
  cleanups.push(
    registerShortcut({
      key: ",",
      description: "Repeat last effect from above on this channel",
      when: () => transport() !== "playing" && view() !== "sample",
      run: h.repeatLastEffectFromAbove,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      position: true,
      description: "Previous pattern at slot",
      when: () => transport() !== "playing",
      run: h.stepPrevPattern,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      position: true,
      description: "Next pattern at slot",
      when: () => transport() !== "playing",
      run: h.stepNextPattern,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      mod: true,
      position: true,
      description: "Insert order slot",
      when: () => transport() !== "playing",
      run: h.insertOrderSlot,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      mod: true,
      position: true,
      description: "Delete order slot",
      when: () => transport() !== "playing",
      run: h.deleteOrderSlot,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "[",
      alt: true,
      position: true,
      description: "New blank pattern at slot",
      when: () => transport() !== "playing",
      run: h.newBlankPatternAtOrder,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "]",
      alt: true,
      position: true,
      description: "Duplicate pattern at slot",
      when: () => transport() !== "playing",
      run: h.duplicateCurrentPattern,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: ".",
      description: "Clear field under cursor",
      run: h.clearAtCursor,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "backspace",
      description: "Clear selection / clear cell, step up",
      run: h.backspaceCell,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "backspace",
      shift: true,
      description:
        "Clear selected rows / clear current row, step up (all channels)",
      run: h.backspaceRow,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "delete",
      description: "Clear selected range",
      run: h.deleteSelection,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "enter",
      description: "Insert empty cell (push channel down)",
      run: h.insertEmptyCell,
    }),
  );
  cleanups.push(
    registerShortcut({
      key: "enter",
      shift: true,
      description: "Insert empty row (push all channels down)",
      run: h.insertEmptyRow,
    }),
  );

  // Per-channel mute / solo. Option/Alt + digit to keep digits without a
  // modifier free for sample selection. Channels are 1..4 in the UI but
  // 0..3 in the API.
  for (let i = 0; i < 4; i++) {
    const channel = i;
    cleanups.push(
      registerShortcut({
        key: `${i + 1}`,
        alt: true,
        description: `Mute channel ${i + 1}`,
        run: () => h.toggleChannelMute(channel),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: `${i + 1}`,
        alt: true,
        shift: true,
        description: `Solo channel ${i + 1}`,
        run: () => h.toggleChannelSolo(channel),
      }),
    );
  }

  return cleanups;
}
