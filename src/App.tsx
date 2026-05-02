import {
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  song,
  setSong,
  transport,
  setTransport,
  playPos,
  setPlayPos,
  canRedo,
  canUndo,
  clearHistory,
  commitEdit,
  commitEditWithWorkbenches,
  redo,
  undo,
} from "./state/song";
import { installShortcuts, registerShortcut } from "./state/shortcuts";
import {
  cursor,
  setCursor,
  resetCursor,
  isHexField,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  pageDown,
  pageUp,
  tabNext,
  tabPrev,
  requestJumpToTop,
} from "./state/cursor";
import { beatsPerBar, rowsPerBeat } from "./state/gridConfig";
import {
  clearFieldPatch,
  currentOctave,
  currentSample,
  editStep,
  incEditStep,
  decEditStep,
  resetEditStep,
  octaveDown,
  octaveUp,
  selectSample,
  nextSample,
  prevSample,
} from "./state/edit";
import { parseModule } from "./core/mod/parser";
import { writeModule } from "./core/mod/writer";
import { deriveExportFilename, io } from "./state/io";
import { PERIOD_TABLE, emptySong } from "./core/mod/format";
import {
  deleteCellPullUp,
  insertCellPushDown,
  setCell,
  nextPatternAtOrder,
  prevPatternAtOrder,
  insertOrder,
  deleteOrder,
  newPatternAtOrder,
  duplicatePatternAtOrder,
  setSample,
  clearSample,
  replaceSampleData,
} from "./core/mod/mutations";
import { cropSample, cutSample } from "./core/mod/sampleSelection";
import {
  readSlice, clearRange, pasteSlice, type PatternRange,
} from "./core/mod/clipboardOps";
import { CHANNELS, ROWS_PER_PATTERN } from "./core/mod/types";
import {
  selection, setSelection, setSelectionAnchor, selectionAnchor,
  makeSelection, clearSelection,
} from "./state/selection";
import { clipboardSlice, setClipboardSlice } from "./state/clipboard";
import {
  workbenchFromWav,
  runPipeline,
  runChain,
  defaultEffect,
  type SampleWorkbench,
  type EffectNode,
  type EffectKind,
  type MonoMix,
} from "./core/audio/sampleWorkbench";
import {
  getWorkbench,
  clearAllWorkbenches,
  withWorkbench,
  withoutWorkbench,
} from "./state/sampleWorkbench";
import { AudioEngine } from "./core/audio/engine";
import { PatternGrid } from "./components/PatternGrid";
import { SampleList } from "./components/SampleList";
import { SampleView, type SampleSelection } from "./components/SampleView";
import { view, setView } from "./state/view";
import * as preview from "./state/preview";

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

let engine: AudioEngine | null = null;

/**
 * Lazy-create the AudioEngine. Returns null when the AudioContext can't be
 * constructed (e.g. in jsdom, or in browsers that gate it behind a user
 * gesture we haven't received yet). Callers must handle null — they treat
 * "no engine" as "no audio side-effect" rather than crashing.
 *
 * This is hit not just by Play, but by every preview path now (note entry,
 * piano-key sample preview), so the user gets sound from the very first
 * keypress without having to press Play first to bootstrap the engine.
 */
async function ensureEngine(): Promise<AudioEngine | null> {
  if (engine) return engine;
  try {
    engine = await AudioEngine.create();
    engine.onPosition = (order, row) => setPlayPos({ order, row });
    return engine;
  } catch {
    return null;
  }
}

/**
 * Ensure the engine exists and push the current Song into it before play.
 * The worklet keeps its own copy of the song, so without this every edit
 * would only show up in the UI — the user would press Play and hear the
 * pre-edit version. Returns null if no song is loaded or the engine
 * couldn't be created.
 */
async function prepareEngine(): Promise<AudioEngine | null> {
  const eng = await ensureEngine();
  if (!eng) return null;
  const s = song();
  if (!s) return null;
  eng.load(s);
  return eng;
}

/**
 * Fire-and-forget audition: lazy-creates the engine if needed, no-ops on
 * failure. Also kicks off the visual playhead tracker so the waveform can
 * draw a position cursor — that runs off performance.now() and doesn't
 * depend on the engine resolving, so the cursor appears immediately even
 * if the AudioContext is still warming up.
 */
function triggerPreview(
  slot: number,
  sample: import("./core/mod/types").Sample,
  period: number,
): void {
  preview.startPreview(slot, sample, period);
  void ensureEngine()
    .then((eng) => {
      if (eng) void eng.previewNote(sample, period);
    })
    .catch(() => {
      /* silent — preview is a best-effort side-effect */
    });
}

export const App: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [filename, setFilename] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  const loadFile = async (file: File) => {
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const mod = parseModule(buf);
      setSong(mod);
      clearHistory();
      // Workbenches are session-only; a fresh .mod gives us new int8 slots
      // with no recipe to re-derive them. Drop any in-memory pipelines.
      clearAllWorkbenches();
      resetCursor();
      setFilename(file.name);
      setPlayPos({ order: 0, row: 0 });
      setTransport("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTransport("idle");
    }
  };

  let fileInput: HTMLInputElement | undefined;

  const onPickFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    // Clear so re-picking the same file still fires onChange.
    input.value = "";
  };

  const openModPicker = () => fileInput?.click();

  /**
   * Serialise the current Song and trigger a browser download. No-op when
   * no song is loaded, but otherwise works at any transport state — saving
   * mid-playback is harmless since `writeModule` is read-only.
   */
  const exportMod = () => {
    const s = song();
    if (!s) return;
    const bytes = writeModule(s);
    io.download(deriveExportFilename(filename(), s.title), bytes);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  const stopPlayback = () => {
    engine?.stop();
    setTransport("ready");
    // Snap the playhead to the cursor so the row tint jumps back to where
    // the user is editing, instead of freezing wherever the song happened
    // to be when stop fired.
    const c = cursor();
    setPlayPos({ order: c.order, row: c.row });
  };

  const playFromStart = async () => {
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(0, 0);
    setTransport("playing");
  };

  const playFromCursor = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, c.row);
    setTransport("playing");
  };

  const playPatternFromStart = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, 0, { loopPattern: true });
    setTransport("playing");
  };

  const playPatternFromCursor = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, c.row, { loopPattern: true });
    setTransport("playing");
  };

  const togglePlay = async () => {
    if (transport() === "playing") stopPlayback();
    else await playFromStart();
  };

  /**
   * Move the cursor to `next`. Disabled during playback (the cursor is also
   * hidden), and while stopped the playhead tracks the cursor so the next
   * Shift+Space (Play from cursor) starts where the user is editing.
   *
   * Plain-cursor moves drop the active range selection AND its anchor —
   * once the user starts navigating with arrows / clicks, the highlighted
   * rectangle is stale and would otherwise just confuse the eye. The
   * shift-arrow / drag handlers go through `extendSelection` instead,
   * which keeps the anchor and updates the selection rectangle as a unit.
   */
  const applyCursor = (next: ReturnType<typeof cursor>) => {
    if (transport() === "playing") return;
    setCursor(next);
    setPlayPos({ order: next.order, row: next.row });
    clearSelection();
  };

  /**
   * Move the cursor to `next` AND extend the selection from its anchor.
   * Used by shift-arrow nav and (indirectly, via PatternGrid) by mouse
   * drag. The first call after a plain navigation re-anchors at the
   * cursor's PRE-MOVE position so the originating cell is included.
   *
   * Selection is single-pattern: if `next.order` differs from the anchor's
   * order, we drop the existing selection and re-anchor at `next`. That
   * keeps the rectangle well-defined without trying to span orders.
   */
  const extendSelection = (next: ReturnType<typeof cursor>) => {
    if (transport() === "playing") return;
    const before = cursor();
    let anchor = selectionAnchor();
    if (!anchor) {
      anchor = { order: before.order, row: before.row, channel: before.channel };
      setSelectionAnchor(anchor);
    }
    setCursor(next);
    setPlayPos({ order: next.order, row: next.row });
    if (next.order !== anchor.order) {
      const reAnchor = { order: next.order, row: next.row, channel: next.channel };
      setSelectionAnchor(reAnchor);
      setSelection(null);
      return;
    }
    setSelection(makeSelection(
      anchor.order,
      anchor.row, anchor.channel,
      next.row, next.channel,
    ));
  };

  /** Same as applyCursor but for movement functions that need the Song. */
  const applyCursorWithSong = (
    fn: (
      c: ReturnType<typeof cursor>,
      s: NonNullable<ReturnType<typeof song>>,
    ) => ReturnType<typeof cursor>,
  ) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    applyCursor(fn(cursor(), s));
  };

  // ─── Shift+arrow range extension ────────────────────────────────────────
  // Shift+left/right hops a WHOLE channel at a time (skipping the per-cell
  // sub-fields the user has to traverse during plain editing) — when the
  // user is sweeping out a selection rectangle the sub-field doesn't
  // matter, so jumping directly to the neighbouring channel matches the
  // user's mental model. Shift+up/down/page step rows. All of these stay
  // within the cursor's current pattern; the selection rectangle is
  // single-pattern by design (see PatternSelection in state/selection.ts).
  const stepChannelLeft = (c: ReturnType<typeof cursor>) =>
    ({ ...c, channel: Math.max(0, c.channel - 1) });
  const stepChannelRight = (c: ReturnType<typeof cursor>) =>
    ({ ...c, channel: Math.min(CHANNELS - 1, c.channel + 1) });
  const stepRowUp = (c: ReturnType<typeof cursor>) =>
    ({ ...c, row: Math.max(0, c.row - 1) });
  const stepRowDown = (c: ReturnType<typeof cursor>) =>
    ({ ...c, row: Math.min(ROWS_PER_PATTERN - 1, c.row + 1) });
  const stepRowPageUp = (c: ReturnType<typeof cursor>, n: number) =>
    ({ ...c, row: Math.max(0, c.row - Math.max(1, n)) });
  const stepRowPageDown = (c: ReturnType<typeof cursor>, n: number) =>
    ({ ...c, row: Math.min(ROWS_PER_PATTERN - 1, c.row + Math.max(1, n)) });

  /**
   * Write a note at the cursor and audition it. No-op if the cursor isn't on
   * the note field, the song isn't loaded, the resulting note is out of
   * ProTracker's 3-octave range, or playback is active (note entry is a
   * stopped-mode action).
   */
  const enterNote = (semitoneOffset: number) => {
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
  };

  /**
   * Audition the current sample at the keyboard-mapped pitch — used in the
   * sample view to preview without touching the song. No commit, no cursor
   * advance, no period write. Out-of-range notes (offsets that fall outside
   * PT's 3-octave table) silently no-op.
   */
  const previewSampleAtPitch = (semitoneOffset: number) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
    if (noteIdx < 0 || noteIdx >= 36) return;
    const period = PERIOD_TABLE[0]![noteIdx]!;
    const sample = s.samples[currentSample() - 1];
    if (sample) triggerPreview(currentSample() - 1, sample, period);
  };

  /**
   * Single piano-key handler that does the right thing per view: write+audition
   * a cell in pattern view, audition-only in sample view. The shortcut's
   * `when` predicate keeps it gated to the appropriate cursor state in pattern
   * view, but in sample view the cursor field doesn't matter — the user just
   * wants to hear notes.
   */
  const onPianoKey = (semitoneOffset: number) => {
    if (view() === "sample") previewSampleAtPitch(semitoneOffset);
    else enterNote(semitoneOffset);
  };

  /**
   * Write one hex nibble (0..F) into the field under the cursor and step
   * the cursor on. Sample numbers are clamped to ProTracker's 1..31 range
   * (5-bit field) — typing a digit that overflows just lands the cell at
   * the cap. Effect command + param have no overflow constraint (cmd is
   * one nibble, param two nibbles — all hex-aligned).
   *
   * Auto-advance is "right within the row, then down on the last sub-field":
   *   sampleHi → sampleLo → (down)
   *   effectCmd → effectHi → effectLo → (down, then jump back to effectCmd)
   * For effects we additionally rewind the field to `effectCmd` after the
   * line break so the user can keep punching three-digit effects without
   * pulling the cursor back left after each one. Matches the multi-digit
   * rhythm in PT/FT2.
   */
  const enterHexDigit = (digit: number) => {
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
      c.field === "sampleHi" ||
      c.field === "effectCmd" ||
      c.field === "effectHi";
    if (stepsRight) {
      applyCursor(moveRight(cursor()));
    } else {
      // Last sub-field of a column → advance by the edit step. At step 0
      // the cursor stays put so the user can keep stamping the same cell.
      advanceByEditStep();
      // After completing a 3-nibble effect, rewind the column to effectCmd
      // on the new row so a follow-up effect can be typed without manually
      // moving the cursor back left. Skip the rewind at edit step 0 — there
      // we WANT the cursor to stay on effectLo for chord-style overwrites.
      if (c.field === "effectLo" && editStep() > 0) {
        applyCursor({ ...cursor(), field: "effectCmd" });
      }
    }
  };

  /**
   * Clear the field under the cursor (note → period, sample → sample number,
   * effect cmd/hi/lo → corresponding effect bytes) and step the cursor down
   * one row. No-op while playing or with no song loaded.
   */
  const clearAtCursor = () => {
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
  };

  /**
   * Copy the most recent non-empty effect on the cursor's channel from any
   * row above the cursor (within the current pattern) into the cursor's
   * cell, then advance. No-op when the cursor is on row 0 or no prior cell
   * on this channel carries an effect — that's a deliberate choice so the
   * key doesn't quietly write zeros and skip a row, which would make
   * accidental presses destructive.
   */
  const repeatLastEffectFromAbove = () => {
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
  };

  /**
   * Step the cursor one row down on the post-edit song. Used by structural
   * actions (Backspace pull-up, Enter push-down) where we always want to
   * track the inserted/deleted row by exactly one — edit step doesn't apply.
   */
  const advanceCursor = () => {
    const s = song();
    if (!s) return;
    applyCursor(moveDown(cursor(), s));
  };

  /**
   * FT2-style row jump after a content entry: advance by `editStep()` rows.
   * 0 leaves the cursor put (useful for stamping chords or overwriting the
   * same cell). Used by note entry, hex entry (when stepping to the next
   * row), clear, and the "repeat last effect" key — anywhere the user has
   * just *added* something to the cell, as opposed to restructuring rows.
   */
  const advanceByEditStep = () => {
    const s = song();
    if (!s) return;
    const step = editStep();
    if (step <= 0) return;
    let next = cursor();
    for (let i = 0; i < step; i++) next = moveDown(next, s);
    applyCursor(next);
  };

  // ─── Range selection / clipboard ────────────────────────────────────────

  /**
   * Cmd+A cycles through three "select all" levels:
   *   1. (no selection or smaller)  → entire current channel
   *   2. (channel-wide selection)   → entire pattern (all rows × 4 ch)
   *   3. (already pattern-wide)     → no further expansion
   *
   * The cycle key is the *exact* selection rectangle — if the user has
   * an arbitrary drag-selection active, Cmd+A jumps straight to step 1.
   */
  const selectAllStep = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    const sel = selection();
    const isWholePattern = !!sel
      && sel.order === c.order
      && sel.startRow === 0
      && sel.endRow === ROWS_PER_PATTERN - 1
      && sel.startChannel === 0
      && sel.endChannel === CHANNELS - 1;
    if (isWholePattern) return; // step 3+ — already maximal, no-op
    const isWholeChannel = !!sel
      && sel.order === c.order
      && sel.startRow === 0
      && sel.endRow === ROWS_PER_PATTERN - 1
      && sel.startChannel === c.channel
      && sel.endChannel === c.channel;
    if (isWholeChannel) {
      // Step 2: expand to the whole pattern.
      setSelection(makeSelection(
        c.order,
        0, 0,
        ROWS_PER_PATTERN - 1, CHANNELS - 1,
      ));
      return;
    }
    // Step 1 (default): select the whole current channel.
    setSelection(makeSelection(
      c.order,
      0, c.channel,
      ROWS_PER_PATTERN - 1, c.channel,
    ));
  };

  /**
   * Build a `PatternRange` from the current selection if any, otherwise from
   * the cursor's single cell. Returns null when no song is loaded — every
   * caller bails on null without erroring so this is a safe pre-check.
   */
  const rangeForClipboard = (): PatternRange | null => {
    if (!song()) return null;
    const sel = selection();
    if (sel) return {
      order: sel.order,
      startRow: sel.startRow, endRow: sel.endRow,
      startChannel: sel.startChannel, endChannel: sel.endChannel,
    };
    const c = cursor();
    return {
      order: c.order,
      startRow: c.row, endRow: c.row,
      startChannel: c.channel, endChannel: c.channel,
    };
  };

  /**
   * Cmd+C: read the selection (or the cursor's cell when nothing's
   * selected) into the in-memory clipboard. The slice is a deep copy so
   * later edits to the song don't mutate what's on the clipboard.
   */
  const copySelection = () => {
    const range = rangeForClipboard();
    if (!range) return;
    const s = song();
    if (!s) return;
    const slice = readSlice(s, range);
    if (!slice) return;
    setClipboardSlice({ rows: slice });
  };

  /**
   * Cmd+X: copy then clear. The clear goes through `commitEdit` so undo
   * restores the cells. After cutting we clear the selection too — the
   * highlighted cells are now empty, and a stale selection rectangle
   * just confuses the eye.
   */
  const cutSelection = () => {
    const range = rangeForClipboard();
    if (!range) return;
    const s = song();
    if (!s) return;
    const slice = readSlice(s, range);
    if (!slice) return;
    setClipboardSlice({ rows: slice });
    commitEdit((song) => clearRange(song, range));
    setSelection(null);
  };

  /**
   * Cmd+V: stamp the clipboard at the cursor. Cells past pattern bounds
   * are silently clipped (pasteSlice handles that). We don't move the
   * cursor or grow a new selection — the user's original placement is
   * the friendliest "after-paste" state to be in.
   */
  const pasteAtCursor = () => {
    if (transport() === "playing") return;
    const slice = clipboardSlice();
    if (!slice || slice.rows.length === 0) return;
    const c = cursor();
    commitEdit((song) =>
      pasteSlice(song, slice.rows, c.order, c.row, c.channel),
    );
  };

  /**
   * Backspace: delete the cell directly above the cursor on this channel and
   * pull the rest of the channel up by one. Cursor moves up one row to land
   * on the now-shifted content, mirroring text-editor backspace. Affects only
   * the current pattern.
   */
  const backspaceCell = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    if (c.row <= 0) return;
    commitEdit((song) => deleteCellPullUp(song, c.order, c.row - 1, c.channel));
    const after = song();
    if (after) applyCursor(moveUp(c, after));
  };

  /**
   * Return: insert an empty cell at the cursor on this channel and push the
   * rest of the channel down by one (last cell falls off). Cursor advances
   * one row so the user can keep building. Affects only the current pattern.
   */
  const insertEmptyCell = () => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const c = cursor();
    commitEdit((song) => insertCellPushDown(song, c.order, c.row, c.channel));
    advanceCursor();
  };

  // ─── Order-list editing ──────────────────────────────────────────────────

  /**
   * Move the edit cursor to a specific order slot, row 0. Drives the user-
   * triggered "jump" path (clicking an order-list slot) — bumps the
   * pattern grid's jump request so the cursor is snapped to the top of
   * the viewport instead of letting the gentle margin-scroller leave it
   * stuck at the bottom of the previous view.
   */
  const jumpToOrder = (order: number) => {
    if (transport() === "playing") return;
    const s = song();
    if (!s) return;
    const clamped = Math.max(0, Math.min(s.songLength - 1, order));
    applyCursor({ ...cursor(), order: clamped, row: 0 });
    requestJumpToTop();
  };

  const stepNextPattern = () => {
    if (transport() === "playing") return;
    const c = cursor();
    commitEdit((song) => nextPatternAtOrder(song, c.order));
  };

  const stepPrevPattern = () => {
    if (transport() === "playing") return;
    const c = cursor();
    commitEdit((song) => prevPatternAtOrder(song, c.order));
  };

  const insertOrderSlot = () => {
    if (transport() === "playing") return;
    const before = song();
    if (!before) return;
    const c = cursor();
    commitEdit((song) => insertOrder(song, c.order));
    const after = song();
    if (!after) return;
    // Skip the cursor advance when `insertOrder` was a no-op (already at
    // MAX_ORDERS — songLength didn't grow). Otherwise advance by one so the
    // cursor lands on the newly-created slot. `insertOrder` duplicates the
    // cursor's pattern number into the new position (so [A, B, C] with the
    // cursor on B becomes [A, B, B, C]); the duplicate sits at c.order + 1,
    // and putting the cursor there is what the user expects so they can
    // immediately step that slot to a different pattern via `<` / `>`.
    if (after.songLength === before.songLength) return;
    applyCursor({ ...c, order: c.order + 1, row: 0 });
    requestJumpToTop();
  };

  /** Delete the slot under the cursor; clamp the cursor if it fell off the end. */
  const deleteOrderSlot = () => {
    if (transport() === "playing") return;
    const c = cursor();
    commitEdit((song) => deleteOrder(song, c.order));
    const after = song();
    if (after && c.order >= after.songLength) {
      applyCursor({ ...cursor(), order: after.songLength - 1, row: 0 });
    }
  };

  const newBlankPatternAtOrder = () => {
    if (transport() === "playing") return;
    const c = cursor();
    commitEdit((song) => newPatternAtOrder(song, c.order));
  };

  /** Append a copy of the current pattern and point the slot at the copy. */
  const duplicateCurrentPattern = () => {
    if (transport() === "playing") return;
    const c = cursor();
    commitEdit((song) => duplicatePatternAtOrder(song, c.order));
  };

  // ─── Sample editing ──────────────────────────────────────────────────────

  /**
   * Patch metadata fields on the currently-selected sample. Gated on
   * `transport !== 'playing'` to match commitEdit's invariant (edits during
   * playback would diverge the on-screen state from the worklet's clone).
   * The SampleView visually disables its meta controls while playing so
   * users see why their click had no effect.
   */
  const patchCurrentSample = (patch: Parameters<typeof setSample>[2]) => {
    if (transport() === "playing") return;
    commitEdit((song) => setSample(song, currentSample() - 1, patch));
  };

  /**
   * Reset the currently-selected sample to empty (also drops its workbench).
   * The song clear and the workbench drop are bundled into a single history
   * entry so undo restores both — the chain UI was previously left dangling
   * after a Clear-then-undo.
   */
  const clearCurrentSample = () => {
    if (transport() === "playing") return;
    const slot = currentSample() - 1;
    commitEditWithWorkbenches(({ song, workbenches }) => ({
      song: clearSample(song, slot),
      workbenches: withoutWorkbench(workbenches, slot),
    }));
  };

  /**
   * Map a byte-range selection (over the int8 output the user sees) into the
   * frame-range that a NEW effect appended to the chain would receive as
   * input. The new effect operates on the OUTPUT of the existing chain
   * (post-effects, pre-transformer), not on the source — so we run the chain
   * once to get its current length and proportionally scale the int8 byte
   * positions into that frame space.
   *
   * Returns null when the chain output is empty or the selection collapses
   * after rounding.
   */
  const selectionToChainFrames = (
    wb: SampleWorkbench,
    startByte: number,
    endByte: number,
    int8Len: number,
  ): { startFrame: number; endFrame: number } | null => {
    const chainOut = runChain(wb.source, wb.chain);
    const chainLen = chainOut.channels[0]?.length ?? 0;
    if (chainLen === 0 || int8Len === 0) return null;
    const startFrame = Math.max(
      0,
      Math.min(chainLen, Math.round((startByte * chainLen) / int8Len)),
    );
    const endFrame = Math.max(
      startFrame,
      Math.min(chainLen, Math.round((endByte * chainLen) / int8Len)),
    );
    if (endFrame - startFrame < 1) return null;
    return { startFrame, endFrame };
  };

  /**
   * Crop / cut the current sample to the selection. When a workbench exists
   * we APPEND the edit as a Crop or Cut effect on the chain — non-destructive,
   * the user can drop the effect from the pipeline editor to undo. When no
   * workbench is present (samples loaded from a `.mod` have no source to
   * preserve), we fall back to direct int8 mutation via cropSample/cutSample.
   */
  const applySelectionEdit = (
    kind: "crop" | "cut",
    startByte: number,
    endByte: number,
  ) => {
    if (transport() === "playing") return;
    const slot = currentSample() - 1;
    const s = song()?.samples[slot];
    if (!s) return;
    const wb = getWorkbench(slot);
    if (wb) {
      const frames = selectionToChainFrames(
        wb,
        startByte,
        endByte,
        s.data.byteLength,
      );
      if (!frames) return;
      const effect: EffectNode = { kind, params: frames };
      updateCurrentWorkbench({ ...wb, chain: [...wb.chain, effect] });
      return;
    }
    // No workbench — destructive int8 mutation, with translated loop. We
    // intentionally drop nothing here (there's no workbench to drop).
    const transform = kind === "crop" ? cropSample : cutSample;
    const result = transform(s, startByte, endByte);
    if (!result) return;
    commitEdit((song) =>
      replaceSampleData(song, slot, result.data, {
        name: s.name,
        volume: s.volume,
        finetune: s.finetune,
        loopStartWords: result.loopStartWords,
        loopLengthWords: result.loopLengthWords,
      }),
    );
  };

  const cropCurrentSampleToSelection = (start: number, end: number) =>
    applySelectionEdit("crop", start, end);
  const cutCurrentSampleSelection = (start: number, end: number) =>
    applySelectionEdit("cut", start, end);

  /**
   * Apply a workbench's pipeline and produce a new Song with the resulting
   * int8 written into `slot`. Pure — used inside `commitEditWithWorkbenches`
   * so the song update and the workbench-map update share one history entry.
   *
   * First write into a fresh slot adopts the source name and full volume.
   * Re-runs (pipeline edits on an already-populated slot) leave the user's
   * name / volume / finetune / loop alone — otherwise dragging a gain slider
   * would silently clobber any volume the user dialed in by hand, and any
   * loop they configured on the waveform. `replaceSampleData` clamps the
   * loop to the new length so a length-changing effect (crop) can't leave
   * the loop pointing past the data.
   */
  const writeWorkbenchToSongPure = (
    song: import("./core/mod/types").Song,
    slot: number,
    wb: SampleWorkbench,
  ): import("./core/mod/types").Song => {
    const data = runPipeline(wb);
    const old = song.samples[slot];
    const isFirstWrite = !old || old.lengthWords === 0;
    const meta: Parameters<typeof replaceSampleData>[3] = isFirstWrite
      ? { volume: 64, finetune: 0, name: wb.sourceName.slice(0, 22) }
      : {
          volume: old.volume,
          finetune: old.finetune,
          name: old.name,
          loopStartWords: old.loopStartWords,
          loopLengthWords: old.loopLengthWords,
        };
    return replaceSampleData(song, slot, data, meta);
  };

  /**
   * Decode a WAV into a workbench for the current slot and run the (initially
   * empty) pipeline. The workbench survives until the user clears the slot
   * or loads a different `.mod`; further pipeline edits go through the
   * addEffect / removeEffect / patchEffect handlers below.
   *
   * Bundles workbench creation + pipeline write into a single history entry
   * so undoing reverts both halves at once.
   */
  const loadWavIntoCurrentSample = (bytes: Uint8Array, filename: string) => {
    if (transport() === "playing") return;
    let wb: SampleWorkbench;
    try {
      wb = workbenchFromWav(bytes, filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    const slot = currentSample() - 1;
    commitEditWithWorkbenches(({ song, workbenches }) => ({
      song: writeWorkbenchToSongPure(song, slot, wb),
      workbenches: withWorkbench(workbenches, slot, wb),
    }));
  };

  /**
   * Replace the workbench at the current slot and re-run the pipeline. Both
   * halves (the workbench map and the int8 in the song) move together inside
   * one history entry — undo reverts the chain UI alongside the waveform.
   */
  const updateCurrentWorkbench = (next: SampleWorkbench) => {
    if (transport() === "playing") return;
    const slot = currentSample() - 1;
    commitEditWithWorkbenches(({ song, workbenches }) => ({
      song: writeWorkbenchToSongPure(song, slot, next),
      workbenches: withWorkbench(workbenches, slot, next),
    }));
  };

  /**
   * Append an effect to the chain. For range-aware kinds (reverse / fadeIn /
   * fadeOut / crop / cut) we use the user's current waveform selection if
   * present — mapping the int8-byte selection back to chain-output frame
   * indices, since the new effect's input is the chain's current output. With
   * no selection, `defaultEffect` picks a sensible default range over that
   * same chain output (whole sample for reverse, head 1024 for fadeIn, etc).
   * gain / normalize ignore selection — they don't take a range.
   */
  const addEffect = (kind: EffectKind, selection: SampleSelection | null) => {
    const slot = currentSample() - 1;
    const wb = getWorkbench(slot);
    if (!wb) return;
    const s = song()?.samples[slot];
    if (!s) return;

    const chainOut = runChain(wb.source, wb.chain);
    let node: EffectNode;
    const isRangeAware =
      kind === "reverse" ||
      kind === "fadeIn" ||
      kind === "fadeOut" ||
      kind === "crop" ||
      kind === "cut";
    if (isRangeAware && selection && s.data.byteLength > 0) {
      const chainLen = chainOut.channels[0]?.length ?? 0;
      const int8Len = s.data.byteLength;
      const startFrame = Math.max(
        0,
        Math.min(chainLen, Math.round((selection.start * chainLen) / int8Len)),
      );
      const endFrame = Math.max(
        startFrame,
        Math.min(chainLen, Math.round((selection.end * chainLen) / int8Len)),
      );
      if (endFrame - startFrame < 1) return;
      node = { kind, params: { startFrame, endFrame } } as EffectNode;
    } else {
      node = defaultEffect(kind, chainOut);
    }
    updateCurrentWorkbench({ ...wb, chain: [...wb.chain, node] });
  };

  const removeEffect = (index: number) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    updateCurrentWorkbench({
      ...wb,
      chain: wb.chain.filter((_, i) => i !== index),
    });
  };

  const moveEffect = (index: number, delta: -1 | 1) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    const target = index + delta;
    if (target < 0 || target >= wb.chain.length) return;
    const chain = [...wb.chain];
    [chain[index], chain[target]] = [chain[target]!, chain[index]!];
    updateCurrentWorkbench({ ...wb, chain });
  };

  /** Replace one node's params (or whole node, for variants without params). */
  const patchEffect = (index: number, next: EffectNode) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    if (index < 0 || index >= wb.chain.length) return;
    const chain = wb.chain.map((n, i) => (i === index ? next : n));
    updateCurrentWorkbench({ ...wb, chain });
  };

  const setMonoMix = (monoMix: MonoMix) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, monoMix } });
  };

  const setTargetNote = (targetNote: number | null) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({ ...wb, pt: { ...wb.pt, targetNote } });
  };

  const cleanups: Array<() => void> = [];
  onMount(() => {
    // Boot with a blank "M.K." song so the user can start editing immediately
    // without having to load a file first. The engine is created lazily on
    // the first Play, so we don't touch AudioContext on mount.
    if (!song()) {
      setSong(emptySong());
      setTransport("ready");
    }
    cleanups.push(installShortcuts());
    cleanups.push(
      registerShortcut({
        key: "o",
        mod: true,
        description: "Open .mod",
        run: openModPicker,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "s",
        mod: true,
        description: "Save .mod",
        run: exportMod,
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
        run: selectAllStep,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "c",
        mod: true,
        description: "Copy selection to clipboard",
        when: () => transport() !== "playing" && view() !== "sample",
        run: copySelection,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "x",
        mod: true,
        description: "Cut selection to clipboard",
        when: () => transport() !== "playing" && view() !== "sample",
        run: cutSelection,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "v",
        mod: true,
        description: "Paste clipboard at cursor",
        when: () => transport() !== "playing" && view() !== "sample",
        run: pasteAtCursor,
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
        run: () => applyCursor(moveLeft(cursor())),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowright",
        description: "Cursor right",
        run: () => applyCursor(moveRight(cursor())),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowup",
        description: "Cursor up",
        run: () => applyCursorWithSong(moveUp),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowdown",
        description: "Cursor down",
        run: () => applyCursorWithSong(moveDown),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "tab",
        description: "Next channel",
        run: () => applyCursor(tabNext(cursor())),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "tab",
        shift: true,
        description: "Previous channel",
        run: () => applyCursor(tabPrev(cursor())),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "pageup",
        description: "Page up",
        run: () =>
          applyCursorWithSong((c, s) =>
            pageUp(c, s, rowsPerBeat() * beatsPerBar()),
          ),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "pagedown",
        description: "Page down",
        run: () =>
          applyCursorWithSong((c, s) =>
            pageDown(c, s, rowsPerBeat() * beatsPerBar()),
          ),
      }),
    );
    // Shift+arrow: extend the range selection. Left/right hop a whole
    // channel (skipping per-cell sub-fields, which are irrelevant for
    // selection rectangles); up/down/page step rows. All gated to pattern
    // view — the cursor signal is shared with sample view but doesn't
    // address a pattern cell there.
    const shiftNav = (mover: (c: ReturnType<typeof cursor>) => ReturnType<typeof cursor>) =>
      () => extendSelection(mover(cursor()));
    cleanups.push(
      registerShortcut({
        key: "arrowleft", shift: true,
        description: "Extend selection left",
        when: () => transport() !== "playing" && view() !== "sample",
        run: shiftNav(stepChannelLeft),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowright", shift: true,
        description: "Extend selection right",
        when: () => transport() !== "playing" && view() !== "sample",
        run: shiftNav(stepChannelRight),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowup", shift: true,
        description: "Extend selection up",
        when: () => transport() !== "playing" && view() !== "sample",
        run: shiftNav(stepRowUp),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "arrowdown", shift: true,
        description: "Extend selection down",
        when: () => transport() !== "playing" && view() !== "sample",
        run: shiftNav(stepRowDown),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "pageup", shift: true,
        description: "Extend selection by a page up",
        when: () => transport() !== "playing" && view() !== "sample",
        run: () => extendSelection(stepRowPageUp(cursor(), rowsPerBeat() * beatsPerBar())),
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "pagedown", shift: true,
        description: "Extend selection by a page down",
        when: () => transport() !== "playing" && view() !== "sample",
        run: () => extendSelection(stepRowPageDown(cursor(), rowsPerBeat() * beatsPerBar())),
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
          description: `Note (offset ${offset})`,
          // Pattern view: only fire on the note field (so A/D/E/F can act as
          // hex digits when the cursor is on a sample / effect nibble).
          // Sample view: always fire (cursor field is irrelevant when we're
          // just auditioning the current slot).
          when: () =>
            transport() !== "playing" &&
            (view() === "sample" || cursor().field === "note"),
          run: () => onPianoKey(offset),
          runUp: () => {
            engine?.stopPreview();
            preview.stopPreview();
          },
        }),
      );
    }
    // Hex-digit entry — fills sample/effect nibbles. Same physical keys as
    // the piano-row letters (A..F) but the `when` gate routes by cursor field.
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
    for (const [k, val] of Object.entries(HEX_KEYS)) {
      cleanups.push(
        registerShortcut({
          key: k,
          description: `Hex digit ${val.toString(16).toUpperCase()}`,
          when: () => transport() !== "playing" && isHexField(cursor().field),
          run: () => enterHexDigit(val),
        }),
      );
    }
    cleanups.push(
      registerShortcut({
        key: "z",
        description: "Octave down",
        run: octaveDown,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "x",
        description: "Octave up",
        run: octaveUp,
      }),
    );
    // Edit step adjust — plain `[` / `]`. The shortcut matcher routes
    // bracket presses by event.code so US, German, Nordic etc. layouts
    // all hit the same binding regardless of where the brackets actually
    // live on the user's keyboard.
    cleanups.push(
      registerShortcut({
        key: "[",
        description: "Decrease edit step",
        when: () => transport() !== "playing",
        run: decEditStep,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "]",
        description: "Increase edit step",
        when: () => transport() !== "playing",
        run: incEditStep,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "\\",
        description: "Reset edit step to 1",
        when: () => transport() !== "playing",
        run: resetEditStep,
      }),
    );
    // Sample quick-select.
    //   1..9, 0          → samples 1..10 (only when cursor is on the note
    //                      field — on hex fields these keys type hex digits)
    //   Shift+1..9, 0    → samples 11..20 (always; hex entry doesn't use shift)
    //   -, =             → previous / next sample
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
    for (const [k, n] of Object.entries(SAMPLE_QUICK)) {
      cleanups.push(
        registerShortcut({
          key: k,
          description: `Select sample ${n}`,
          // Suppress in sample view so digits flow into the sample-editor's
          // numeric inputs (volume / finetune / loop / effect params) instead
          // of preventDefault'ing into a sample-select.
          when: () =>
            transport() !== "playing" &&
            view() !== "sample" &&
            !isHexField(cursor().field),
          run: () => selectSample(n),
        }),
      );
      cleanups.push(
        registerShortcut({
          key: k,
          shift: true,
          description: `Select sample ${n + 10}`,
          when: () => transport() !== "playing" && view() !== "sample",
          run: () => selectSample(n + 10),
        }),
      );
    }
    cleanups.push(
      registerShortcut({
        key: "-",
        description: "Previous sample",
        when: () => transport() !== "playing" && view() !== "sample",
        run: prevSample,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "=",
        description: "Next sample",
        when: () => transport() !== "playing" && view() !== "sample",
        run: nextSample,
      }),
    );
    // Order-list editing. The cursor's `order` field is the target slot.
    //   < / >          → step the slot's pattern number ±1 (auto-grows on >)
    //   Cmd/Ctrl + I   → insert a new slot at the cursor (duplicates current)
    //   Cmd/Ctrl + D   → delete the slot at the cursor
    //   Cmd/Ctrl + B   → assign a fresh empty pattern to the current slot
    // Plain `,` (without shift, which is the order-step `<`): copy the
    // most recent non-empty effect on the cursor's channel from any row
    // above and advance. Pattern-view only — the cursor signal is shared
    // with the sample view but doesn't address a pattern cell there.
    cleanups.push(
      registerShortcut({
        key: ",",
        description: "Repeat last effect from above on this channel",
        when: () => transport() !== "playing" && view() !== "sample",
        run: repeatLastEffectFromAbove,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: ",",
        shift: true,
        description: "Previous pattern at slot",
        when: () => transport() !== "playing",
        run: stepPrevPattern,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: ".",
        shift: true,
        description: "Next pattern at slot",
        when: () => transport() !== "playing",
        run: stepNextPattern,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "i",
        mod: true,
        description: "Insert order slot",
        when: () => transport() !== "playing",
        run: insertOrderSlot,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "d",
        mod: true,
        description: "Delete order slot",
        when: () => transport() !== "playing",
        run: deleteOrderSlot,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "b",
        mod: true,
        description: "New blank pattern at slot",
        when: () => transport() !== "playing",
        run: newBlankPatternAtOrder,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "b",
        mod: true,
        shift: true,
        description: "Duplicate pattern at slot",
        when: () => transport() !== "playing",
        run: duplicateCurrentPattern,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: ".",
        description: "Clear field under cursor",
        run: clearAtCursor,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "backspace",
        description: "Delete cell above (pull channel up)",
        run: backspaceCell,
      }),
    );
    cleanups.push(
      registerShortcut({
        key: "enter",
        description: "Insert empty cell (push channel down)",
        run: insertEmptyCell,
      }),
    );
  });
  onCleanup(() => {
    for (const c of cleanups) c();
    preview.stopPreview();
    void engine?.dispose();
    engine = null;
  });

  const sampleCount = createMemo(() => {
    const s = song();
    if (!s) return 0;
    return s.samples.filter((x) => x.lengthWords > 0).length;
  });

  return (
    <div
      class="app"
      classList={{
        "app--drag": dragOver(),
        "app--view-pattern": view() === "pattern",
        "app--view-sample": view() === "sample",
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header class="app__header">
        <h1>RetroTracker</h1>
        <div class="viewtabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "pattern" }}
            aria-selected={view() === "pattern"}
            onClick={() => setView("pattern")}
            title="Pattern view (F2)"
          >
            Pattern
          </button>
          <button
            type="button"
            role="tab"
            classList={{ "viewtab--active": view() === "sample" }}
            aria-selected={view() === "sample"}
            onClick={() => setView("sample")}
            title="Sample view (F3)"
          >
            Sample
          </button>
        </div>
        <div class="transport">
          <label class="file-button" title="Open .mod (⌘O)">
            <input
              type="file"
              accept=".mod"
              onChange={onPickFile}
              hidden
              ref={fileInput}
            />
            Open .mod…
          </label>
          <button
            onClick={exportMod}
            disabled={!song()}
            title="Save .mod (⌘S)"
            aria-label="Save .mod"
          >
            Save .mod…
          </button>
          <button
            onClick={() => void togglePlay()}
            disabled={!song()}
            title="Play / Stop (Space)"
          >
            {transport() === "playing" ? "Stop" : "Play"}
          </button>
          <button
            onClick={undo}
            disabled={!canUndo() || transport() === "playing"}
            title="Undo (⌘Z)"
          >
            Undo
          </button>
          <button
            onClick={redo}
            disabled={!canRedo() || transport() === "playing"}
            title="Redo (⇧⌘Z)"
          >
            Redo
          </button>
        </div>
      </header>

      <aside class="app__samples">
        <h2>Samples</h2>
        <SampleList song={song()} onSelect={selectSample} />
      </aside>

      <main class="app__main">
        <Show
          when={song()}
          fallback={
            <div class="dropzone">
              <p>
                Drop a <code>.mod</code> file anywhere, or use{" "}
                <em>Load .mod…</em>
              </p>
              <Show when={error()}>
                <p class="error">{error()}</p>
              </Show>
            </div>
          }
        >
          {(s) => (
            <Show
              when={view() === "pattern"}
              fallback={
                <SampleView
                  song={s()}
                  onLoadWav={loadWavIntoCurrentSample}
                  onClear={clearCurrentSample}
                  onPatch={patchCurrentSample}
                  onCropToSelection={cropCurrentSampleToSelection}
                  onCutSelection={cutCurrentSampleSelection}
                  onAddEffect={addEffect}
                  onRemoveEffect={removeEffect}
                  onMoveEffect={moveEffect}
                  onPatchEffect={patchEffect}
                  onSetMonoMix={setMonoMix}
                  onSetTargetNote={setTargetNote}
                />
              }
            >
              <div class="patternpane">
                <div class="patternpane__meta">
                  <span class="patternpane__title">
                    {s().title || <em>(untitled)</em>}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>{filename()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>{sampleCount()} samples</span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    order {playPos().order.toString(16).toUpperCase().padStart(2, "0")}/
                    {(s().songLength - 1).toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>
                    pat{" "}
                    {(s().orders[playPos().order] ?? 0).toString(16).toUpperCase().padStart(2, "0")}
                  </span>
                  <span class="patternpane__sep">·</span>
                  <span>row {playPos().row.toString(16).toUpperCase().padStart(2, "0")}</span>
                  <span class="patternpane__sep">·</span>
                  <span>oct {currentOctave()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>smp {currentSample().toString(16).toUpperCase().padStart(2, "0")}</span>
                  <span class="patternpane__sep">·</span>
                  <span class="patternpane__editstep">
                    step
                    <button
                      type="button"
                      class="patternpane__editstep-btn"
                      onClick={decEditStep}
                      disabled={transport() === "playing"}
                      title="Decrease edit step ([)"
                      aria-label="Decrease edit step"
                    >−</button>
                    <span
                      class="patternpane__editstep-value"
                      aria-label="Edit step"
                    >{editStep()}</span>
                    <button
                      type="button"
                      class="patternpane__editstep-btn"
                      onClick={incEditStep}
                      disabled={transport() === "playing"}
                      title="Increase edit step (])"
                      aria-label="Increase edit step"
                    >+</button>
                  </span>
                </div>
                <PatternGrid
                  song={s()}
                  pos={playPos()}
                  active={transport() === "playing"}
                  onCellClick={applyCursor}
                />
              </div>
            </Show>
          )}
        </Show>
      </main>

      <Show when={view() === "pattern"}>
        <aside class="app__order">
          <h2>Order</h2>
          <Show when={song()} fallback={<p class="placeholder">—</p>}>
            {(s) => {
              // Disable a button when the corresponding action would no-op so
              // the UI doesn't lie about what's possible. `playing` blocks
              // every edit (mirrors the rules in the keyboard handlers).
              const playing = () => transport() === "playing";
              const slotPat = () => s().orders[cursor().order] ?? 0;
              const canPrev = () => !playing() && slotPat() > 0;
              const canNext = () => !playing();
              const canIns = () =>
                !playing() && s().songLength < s().orders.length;
              const canDel = () => !playing() && s().songLength > 1;
              const canBlank = () => !playing();
              return (
                <>
                  <div class="ordertools">
                    <button
                      type="button"
                      onClick={stepPrevPattern}
                      disabled={!canPrev()}
                      title="Previous pattern at slot (<)"
                      aria-label="Previous pattern at slot"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      onClick={stepNextPattern}
                      disabled={!canNext()}
                      title="Next pattern at slot (>)"
                      aria-label="Next pattern at slot"
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      onClick={insertOrderSlot}
                      disabled={!canIns()}
                      title="Insert slot at cursor (⌘I)"
                      aria-label="Insert slot"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={deleteOrderSlot}
                      disabled={!canDel()}
                      title="Delete slot at cursor (⌘D)"
                      aria-label="Delete slot"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={newBlankPatternAtOrder}
                      disabled={!canBlank()}
                      title="New blank pattern at slot (⌘B)"
                      aria-label="New blank pattern"
                    >
                      New
                    </button>
                    <button
                      type="button"
                      onClick={duplicateCurrentPattern}
                      disabled={!canBlank()}
                      title="Duplicate pattern at slot (⌘⇧B)"
                      aria-label="Duplicate pattern"
                    >
                      Dup
                    </button>
                  </div>
                  <ol class="orderlist">
                    {s()
                      .orders.slice(0, s().songLength)
                      .map((p, i) => (
                        <li
                          classList={{
                            "orderlist__item--active": i === playPos().order,
                            "orderlist__item--cursor":
                              transport() !== "playing" && i === cursor().order,
                          }}
                          onClick={() => jumpToOrder(i)}
                          title={`Jump to order ${i.toString(16).toUpperCase().padStart(2, "0")}`}
                        >
                          <span class="num">{i.toString(16).toUpperCase().padStart(2, "0")}</span>
                          <span class="pat">{p.toString(16).toUpperCase().padStart(2, "0")}</span>
                        </li>
                      ))}
                  </ol>
                </>
              );
            }}
          </Show>
        </aside>
      </Show>
    </div>
  );
};
