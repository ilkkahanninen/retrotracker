import { Show, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import {
  song, setSong, transport, setTransport, playPos, setPlayPos,
  canRedo, canUndo, clearHistory, commitEdit, redo, undo,
} from './state/song';
import { installShortcuts, registerShortcut } from './state/shortcuts';
import {
  cursor, setCursor, resetCursor, isHexField,
  moveDown, moveLeft, moveRight, moveUp, pageDown, pageUp, tabNext, tabPrev,
} from './state/cursor';
import { beatsPerBar, rowsPerBeat } from './state/gridConfig';
import {
  clearFieldPatch, currentOctave, currentSample,
  octaveDown, octaveUp,
  selectSample, nextSample, prevSample,
} from './state/edit';
import { parseModule } from './core/mod/parser';
import { writeModule } from './core/mod/writer';
import { deriveExportFilename, io } from './state/io';
import { PERIOD_TABLE, emptySong } from './core/mod/format';
import {
  deleteCellPullUp, insertCellPushDown, setCell,
  nextPatternAtOrder, prevPatternAtOrder,
  insertOrder, deleteOrder, newPatternAtOrder, duplicatePatternAtOrder,
  setSample, clearSample, replaceSampleData,
} from './core/mod/mutations';
import {
  workbenchFromWav, runPipeline, defaultEffect,
  type SampleWorkbench, type EffectNode, type EffectKind, type MonoMix,
} from './core/audio/sampleWorkbench';
import {
  getWorkbench, setWorkbench, clearWorkbench, clearAllWorkbenches,
} from './state/sampleWorkbench';
import { AudioEngine } from './core/audio/engine';
import { PatternGrid } from './components/PatternGrid';
import { SampleList } from './components/SampleList';
import { SampleView } from './components/SampleView';
import { view, setView } from './state/view';
import * as preview from './state/preview';

/**
 * Piano-row key mapping → semitone offset from the current octave's C.
 *   row 1 (white keys A S D F G H J K L ;)  + row 0 sharps (W E   T Y U   O P)
 */
const PIANO_KEYS: Readonly<Record<string, number>> = {
  a: 0,   // C
  w: 1,   // C#
  s: 2,   // D
  e: 3,   // D#
  d: 4,   // E
  f: 5,   // F
  t: 6,   // F#
  g: 7,   // G
  y: 8,   // G#
  h: 9,   // A
  u: 10,  // A#
  j: 11,  // B
  k: 12,  // C +1 octave
  o: 13,  // C# +1
  l: 14,  // D +1
  p: 15,  // D# +1
  ';': 16, // E +1
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
function triggerPreview(slot: number, sample: import('./core/mod/types').Sample, period: number): void {
  preview.startPreview(slot, sample, period);
  void ensureEngine().then((eng) => {
    if (eng) void eng.previewNote(sample, period);
  }).catch(() => { /* silent — preview is a best-effort side-effect */ });
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
      setTransport('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTransport('idle');
    }
  };

  let fileInput: HTMLInputElement | undefined;

  const onPickFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    // Clear so re-picking the same file still fires onChange.
    input.value = '';
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
    setTransport('ready');
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
    setTransport('playing');
  };

  const playFromCursor = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, c.row);
    setTransport('playing');
  };

  const playPatternFromStart = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, 0, { loopPattern: true });
    setTransport('playing');
  };

  const playPatternFromCursor = async () => {
    const c = cursor();
    const eng = await prepareEngine();
    if (!eng) return;
    await eng.playFrom(c.order, c.row, { loopPattern: true });
    setTransport('playing');
  };

  const togglePlay = async () => {
    if (transport() === 'playing') stopPlayback();
    else await playFromStart();
  };

  /**
   * Move the cursor to `next`. Disabled during playback (the cursor is also
   * hidden), and while stopped the playhead tracks the cursor so the next
   * Shift+Space (Play from cursor) starts where the user is editing.
   */
  const applyCursor = (next: ReturnType<typeof cursor>) => {
    if (transport() === 'playing') return;
    setCursor(next);
    setPlayPos({ order: next.order, row: next.row });
  };

  /** Same as applyCursor but for movement functions that need the Song. */
  const applyCursorWithSong = (
    fn: (c: ReturnType<typeof cursor>, s: NonNullable<ReturnType<typeof song>>) => ReturnType<typeof cursor>,
  ) => {
    if (transport() === 'playing') return;
    const s = song();
    if (!s) return;
    applyCursor(fn(cursor(), s));
  };

  /**
   * Write a note at the cursor and audition it. No-op if the cursor isn't on
   * the note field, the song isn't loaded, the resulting note is out of
   * ProTracker's 3-octave range, or playback is active (note entry is a
   * stopped-mode action).
   */
  const enterNote = (semitoneOffset: number) => {
    if (transport() === 'playing') return;
    const c = cursor();
    if (c.field !== 'note') return;
    const s = song();
    if (!s) return;
    const noteIdx = (currentOctave() - 1) * 12 + semitoneOffset;
    if (noteIdx < 0 || noteIdx >= 36) return;
    const period = PERIOD_TABLE[0]![noteIdx]!;
    const sampleNum = currentSample();

    commitEdit((song) => setCell(song, c.order, c.row, c.channel, {
      period, sample: sampleNum,
    }));
    advanceCursor();

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
    if (transport() === 'playing') return;
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
    if (view() === 'sample') previewSampleAtPitch(semitoneOffset);
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
   *   effectCmd → effectHi → effectLo → (down)
   * Matches the multi-digit rhythm in PT/FT2.
   */
  const enterHexDigit = (digit: number) => {
    if (transport() === 'playing') return;
    const c = cursor();
    const s = song();
    if (!s) return;
    const pat = s.patterns[s.orders[c.order] ?? -1];
    const note = pat?.rows[c.row]?.[c.channel];
    if (!note) return;

    let patch: Partial<typeof note> | null = null;
    switch (c.field) {
      case 'sampleHi': {
        const raw = ((digit & 0x0f) << 4) | (note.sample & 0x0f);
        patch = { sample: Math.min(31, raw) };
        break;
      }
      case 'sampleLo': {
        const raw = (note.sample & 0xf0) | (digit & 0x0f);
        patch = { sample: Math.min(31, raw) };
        break;
      }
      case 'effectCmd':
        patch = { effect: digit & 0x0f };
        break;
      case 'effectHi':
        patch = { effectParam: ((digit & 0x0f) << 4) | (note.effectParam & 0x0f) };
        break;
      case 'effectLo':
        patch = { effectParam: (note.effectParam & 0xf0) | (digit & 0x0f) };
        break;
      default: return;
    }

    commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
    const stepsRight = c.field === 'sampleHi'
      || c.field === 'effectCmd'
      || c.field === 'effectHi';
    if (stepsRight) applyCursor(moveRight(cursor()));
    else advanceCursor();
  };

  /**
   * Clear the field under the cursor (note → period, sample → sample number,
   * effect cmd/hi/lo → corresponding effect bytes) and step the cursor down
   * one row. No-op while playing or with no song loaded.
   */
  const clearAtCursor = () => {
    if (transport() === 'playing') return;
    const s = song();
    if (!s) return;
    const c = cursor();
    const pat = s.patterns[s.orders[c.order] ?? -1];
    const note = pat?.rows[c.row]?.[c.channel];
    if (!note) return;
    const patch = clearFieldPatch(note, c.field);
    commitEdit((song) => setCell(song, c.order, c.row, c.channel, patch));
    advanceCursor();
  };

  /** Step the cursor one row down on the post-edit song. Called after note entry / clear. */
  const advanceCursor = () => {
    const s = song();
    if (!s) return;
    applyCursor(moveDown(cursor(), s));
  };

  /**
   * Backspace: delete the cell directly above the cursor on this channel and
   * pull the rest of the channel up by one. Cursor moves up one row to land
   * on the now-shifted content, mirroring text-editor backspace. Affects only
   * the current pattern.
   */
  const backspaceCell = () => {
    if (transport() === 'playing') return;
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
    if (transport() === 'playing') return;
    const s = song();
    if (!s) return;
    const c = cursor();
    commitEdit((song) => insertCellPushDown(song, c.order, c.row, c.channel));
    advanceCursor();
  };

  // ─── Order-list editing ──────────────────────────────────────────────────

  /** Move the edit cursor to a specific order slot, row 0. */
  const jumpToOrder = (order: number) => {
    if (transport() === 'playing') return;
    const s = song();
    if (!s) return;
    const clamped = Math.max(0, Math.min(s.songLength - 1, order));
    applyCursor({ ...cursor(), order: clamped, row: 0 });
  };

  const stepNextPattern = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => nextPatternAtOrder(song, c.order));
  };

  const stepPrevPattern = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => prevPatternAtOrder(song, c.order));
  };

  const insertOrderSlot = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => insertOrder(song, c.order));
  };

  /** Delete the slot under the cursor; clamp the cursor if it fell off the end. */
  const deleteOrderSlot = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => deleteOrder(song, c.order));
    const after = song();
    if (after && c.order >= after.songLength) {
      applyCursor({ ...cursor(), order: after.songLength - 1, row: 0 });
    }
  };

  const newBlankPatternAtOrder = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => newPatternAtOrder(song, c.order));
  };

  /** Append a copy of the current pattern and point the slot at the copy. */
  const duplicateCurrentPattern = () => {
    if (transport() === 'playing') return;
    const c = cursor();
    commitEdit((song) => duplicatePatternAtOrder(song, c.order));
  };

  // ─── Sample editing ──────────────────────────────────────────────────────

  /** Patch metadata fields on the currently-selected sample. */
  const patchCurrentSample = (patch: Parameters<typeof setSample>[2]) => {
    if (transport() === 'playing') return;
    commitEdit((song) => setSample(song, currentSample() - 1, patch));
  };

  /** Reset the currently-selected sample to empty (also drops its workbench). */
  const clearCurrentSample = () => {
    if (transport() === 'playing') return;
    const slot = currentSample() - 1;
    clearWorkbench(slot);
    commitEdit((song) => clearSample(song, slot));
  };

  /**
   * Apply a workbench's pipeline (chain → PT transformer) and write the
   * resulting int8 into its sample slot. Stamps a sensible default name from
   * the source filename when the slot was empty before — otherwise preserves
   * whatever name the user has set.
   */
  const writeWorkbenchToSong = (slot: number, wb: SampleWorkbench) => {
    const data = runPipeline(wb);
    commitEdit((song) => {
      const old = song.samples[slot];
      // First write into a fresh slot adopts the source name and full volume.
      // Re-runs (pipeline edits on an already-populated slot) leave the user's
      // name / volume / finetune alone — otherwise dragging a gain slider
      // would silently clobber any volume the user had dialed in by hand.
      const isFirstWrite = !old || old.lengthWords === 0;
      const meta: Parameters<typeof replaceSampleData>[3] = isFirstWrite
        ? { volume: 64, finetune: 0, name: wb.sourceName.slice(0, 22) }
        : { volume: old.volume, finetune: old.finetune, name: old.name };
      return replaceSampleData(song, slot, data, meta);
    });
  };

  /**
   * Decode a WAV into a workbench for the current slot and run the (initially
   * empty) pipeline. The workbench survives until the user clears the slot
   * or loads a different `.mod`; further pipeline edits go through the
   * patchWorkbench / addEffect / removeEffect handlers below.
   */
  const loadWavIntoCurrentSample = (bytes: Uint8Array, filename: string) => {
    if (transport() === 'playing') return;
    let wb: SampleWorkbench;
    try {
      wb = workbenchFromWav(bytes, filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    const slot = currentSample() - 1;
    setWorkbench(slot, wb);
    writeWorkbenchToSong(slot, wb);
  };

  /** Replace the workbench at the current slot and re-run the pipeline. */
  const updateCurrentWorkbench = (next: SampleWorkbench) => {
    if (transport() === 'playing') return;
    const slot = currentSample() - 1;
    setWorkbench(slot, next);
    writeWorkbenchToSong(slot, next);
  };

  /** Append an effect of the given kind with default params. */
  const addEffect = (kind: EffectKind) => {
    const wb = getWorkbench(currentSample() - 1);
    if (!wb) return;
    updateCurrentWorkbench({
      ...wb,
      chain: [...wb.chain, defaultEffect(kind, wb.source)],
    });
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
      setTransport('ready');
    }
    cleanups.push(installShortcuts());
    cleanups.push(registerShortcut({
      key: 'o', mod: true, description: 'Open .mod', run: openModPicker,
    }));
    cleanups.push(registerShortcut({
      key: 's', mod: true, description: 'Save .mod', run: exportMod,
    }));
    cleanups.push(registerShortcut({
      key: 'f2', description: 'Pattern view', run: () => setView('pattern'),
    }));
    cleanups.push(registerShortcut({
      key: 'f3', description: 'Sample view', run: () => setView('sample'),
    }));
    // Transport (Space-based chords; Option used instead of Cmd to avoid the
    // macOS Spotlight conflict on ⌘+Space).
    //   Space               → toggle: stop if playing, otherwise play song from start
    //   Option + Space      → play pattern (loop) from start of cursor's pattern
    //   Shift + Space       → play song from cursor
    //   Option + Shift + Space → play pattern (loop) from cursor row
    cleanups.push(registerShortcut({
      key: ' ', description: 'Play / Stop', run: () => {
        if (transport() === 'playing') stopPlayback();
        else void playFromStart();
      },
    }));
    cleanups.push(registerShortcut({
      key: ' ', alt: true, description: 'Play pattern (loop)', run: () => { void playPatternFromStart(); },
    }));
    cleanups.push(registerShortcut({
      key: ' ', shift: true, description: 'Play song from cursor', run: () => { void playFromCursor(); },
    }));
    cleanups.push(registerShortcut({
      key: ' ', alt: true, shift: true, description: 'Play pattern from cursor (loop)', run: () => { void playPatternFromCursor(); },
    }));
    // Cursor navigation (no-op while playing — handled inside applyCursor)
    cleanups.push(registerShortcut({
      key: 'arrowleft',  description: 'Cursor left',  run: () => applyCursor(moveLeft(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowright', description: 'Cursor right', run: () => applyCursor(moveRight(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowup',    description: 'Cursor up',    run: () => applyCursorWithSong(moveUp),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowdown',  description: 'Cursor down',  run: () => applyCursorWithSong(moveDown),
    }));
    cleanups.push(registerShortcut({
      key: 'tab',                description: 'Next channel',     run: () => applyCursor(tabNext(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'tab', shift: true,    description: 'Previous channel', run: () => applyCursor(tabPrev(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'pageup',   description: 'Page up',   run: () => applyCursorWithSong((c, s) => pageUp(c, s, rowsPerBeat() * beatsPerBar())),
    }));
    cleanups.push(registerShortcut({
      key: 'pagedown', description: 'Page down', run: () => applyCursorWithSong((c, s) => pageDown(c, s, rowsPerBeat() * beatsPerBar())),
    }));
    // Note entry — piano-row keys when the cursor is on the note field.
    // `runUp` stops the audition preview when the key is released, so held
    // notes (especially looping samples) don't keep ringing forever.
    //
    // The `when` gate matters because A/D/E/F (and others) double as hex
    // digits when the cursor is on a hex-editable field; without it, the
    // piano shortcut would shadow the hex shortcut on those overlapping keys.
    for (const [k, offset] of Object.entries(PIANO_KEYS)) {
      cleanups.push(registerShortcut({
        key: k,
        description: `Note (offset ${offset})`,
        // Pattern view: only fire on the note field (so A/D/E/F can act as
        // hex digits when the cursor is on a sample / effect nibble).
        // Sample view: always fire (cursor field is irrelevant when we're
        // just auditioning the current slot).
        when: () => transport() !== 'playing'
          && (view() === 'sample' || cursor().field === 'note'),
        run: () => onPianoKey(offset),
        runUp: () => { engine?.stopPreview(); preview.stopPreview(); },
      }));
    }
    // Hex-digit entry — fills sample/effect nibbles. Same physical keys as
    // the piano-row letters (A..F) but the `when` gate routes by cursor field.
    const HEX_KEYS: Readonly<Record<string, number>> = {
      '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
      '8': 8, '9': 9, a: 10, b: 11, c: 12, d: 13, e: 14, f: 15,
    };
    for (const [k, val] of Object.entries(HEX_KEYS)) {
      cleanups.push(registerShortcut({
        key: k,
        description: `Hex digit ${val.toString(16).toUpperCase()}`,
        when: () => transport() !== 'playing' && isHexField(cursor().field),
        run: () => enterHexDigit(val),
      }));
    }
    cleanups.push(registerShortcut({
      key: 'z', description: 'Octave down', run: octaveDown,
    }));
    cleanups.push(registerShortcut({
      key: 'x', description: 'Octave up', run: octaveUp,
    }));
    // Sample quick-select.
    //   1..9, 0          → samples 1..10 (only when cursor is on the note
    //                      field — on hex fields these keys type hex digits)
    //   Shift+1..9, 0    → samples 11..20 (always; hex entry doesn't use shift)
    //   -, =             → previous / next sample
    const SAMPLE_QUICK: Readonly<Record<string, number>> = {
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
      '6': 6, '7': 7, '8': 8, '9': 9, '0': 10,
    };
    for (const [k, n] of Object.entries(SAMPLE_QUICK)) {
      cleanups.push(registerShortcut({
        key: k,
        description: `Select sample ${n}`,
        // Suppress in sample view so digits flow into the sample-editor's
        // numeric inputs (volume / finetune / loop / effect params) instead
        // of preventDefault'ing into a sample-select.
        when: () => transport() !== 'playing'
          && view() !== 'sample'
          && !isHexField(cursor().field),
        run: () => selectSample(n),
      }));
      cleanups.push(registerShortcut({
        key: k, shift: true,
        description: `Select sample ${n + 10}`,
        when: () => transport() !== 'playing' && view() !== 'sample',
        run: () => selectSample(n + 10),
      }));
    }
    cleanups.push(registerShortcut({
      key: '-',
      description: 'Previous sample',
      when: () => transport() !== 'playing' && view() !== 'sample',
      run: prevSample,
    }));
    cleanups.push(registerShortcut({
      key: '=',
      description: 'Next sample',
      when: () => transport() !== 'playing' && view() !== 'sample',
      run: nextSample,
    }));
    // Order-list editing. The cursor's `order` field is the target slot.
    //   < / >          → step the slot's pattern number ±1 (auto-grows on >)
    //   Cmd/Ctrl + I   → insert a new slot at the cursor (duplicates current)
    //   Cmd/Ctrl + D   → delete the slot at the cursor
    //   Cmd/Ctrl + B   → assign a fresh empty pattern to the current slot
    cleanups.push(registerShortcut({
      key: ',', shift: true,
      description: 'Previous pattern at slot',
      when: () => transport() !== 'playing',
      run: stepPrevPattern,
    }));
    cleanups.push(registerShortcut({
      key: '.', shift: true,
      description: 'Next pattern at slot',
      when: () => transport() !== 'playing',
      run: stepNextPattern,
    }));
    cleanups.push(registerShortcut({
      key: 'i', mod: true,
      description: 'Insert order slot',
      when: () => transport() !== 'playing',
      run: insertOrderSlot,
    }));
    cleanups.push(registerShortcut({
      key: 'd', mod: true,
      description: 'Delete order slot',
      when: () => transport() !== 'playing',
      run: deleteOrderSlot,
    }));
    cleanups.push(registerShortcut({
      key: 'b', mod: true,
      description: 'New blank pattern at slot',
      when: () => transport() !== 'playing',
      run: newBlankPatternAtOrder,
    }));
    cleanups.push(registerShortcut({
      key: 'b', mod: true, shift: true,
      description: 'Duplicate pattern at slot',
      when: () => transport() !== 'playing',
      run: duplicateCurrentPattern,
    }));
    cleanups.push(registerShortcut({
      key: '.', description: 'Clear field under cursor', run: clearAtCursor,
    }));
    cleanups.push(registerShortcut({
      key: 'backspace', description: 'Delete cell above (pull channel up)', run: backspaceCell,
    }));
    cleanups.push(registerShortcut({
      key: 'enter',     description: 'Insert empty cell (push channel down)', run: insertEmptyCell,
    }));
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
    return s.samples.filter(x => x.lengthWords > 0).length;
  });

  return (
    <div
      class="app"
      classList={{
        'app--drag': dragOver(),
        'app--view-pattern': view() === 'pattern',
        'app--view-sample':  view() === 'sample',
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
            classList={{ 'viewtab--active': view() === 'pattern' }}
            aria-selected={view() === 'pattern'}
            onClick={() => setView('pattern')}
            title="Pattern view (F2)"
          >Pattern</button>
          <button
            type="button"
            role="tab"
            classList={{ 'viewtab--active': view() === 'sample' }}
            aria-selected={view() === 'sample'}
            onClick={() => setView('sample')}
            title="Sample view (F3)"
          >Sample</button>
        </div>
        <div class="transport">
          <label class="file-button" title="Open .mod (⌘O)">
            <input type="file" accept=".mod" onChange={onPickFile} hidden ref={fileInput} />
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
            {transport() === 'playing' ? 'Stop' : 'Play'}
          </button>
          <button
            onClick={undo}
            disabled={!canUndo() || transport() === 'playing'}
            title="Undo (⌘Z)"
          >
            Undo
          </button>
          <button
            onClick={redo}
            disabled={!canRedo() || transport() === 'playing'}
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
              <p>Drop a <code>.mod</code> file anywhere, or use <em>Load .mod…</em></p>
              <Show when={error()}>
                <p class="error">{error()}</p>
              </Show>
            </div>
          }
        >
          {(s) => (
            <Show
              when={view() === 'pattern'}
              fallback={
                <SampleView
                  song={s()}
                  onLoadWav={loadWavIntoCurrentSample}
                  onClear={clearCurrentSample}
                  onPatch={patchCurrentSample}
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
                  <span class="patternpane__title">{s().title || <em>(untitled)</em>}</span>
                  <span class="patternpane__sep">·</span>
                  <span>{filename()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>{sampleCount()} samples</span>
                  <span class="patternpane__sep">·</span>
                  <span>order {String(playPos().order).padStart(2, '0')}/{String(s().songLength - 1).padStart(2, '0')}</span>
                  <span class="patternpane__sep">·</span>
                  <span>pat {String(s().orders[playPos().order] ?? 0).padStart(2, '0')}</span>
                  <span class="patternpane__sep">·</span>
                  <span>row {String(playPos().row).padStart(2, '0')}</span>
                  <span class="patternpane__sep">·</span>
                  <span>oct {currentOctave()}</span>
                  <span class="patternpane__sep">·</span>
                  <span>smp {String(currentSample()).padStart(2, '0')}</span>
                </div>
                <PatternGrid song={s()} pos={playPos()} active={transport() === 'playing'} />
              </div>
            </Show>
          )}
        </Show>
      </main>

      <Show when={view() === 'pattern'}>
       <aside class="app__order">
        <h2>Order</h2>
        <Show when={song()} fallback={<p class="placeholder">—</p>}>
          {(s) => {
            // Disable a button when the corresponding action would no-op so
            // the UI doesn't lie about what's possible. `playing` blocks
            // every edit (mirrors the rules in the keyboard handlers).
            const playing  = () => transport() === 'playing';
            const slotPat  = () => s().orders[cursor().order] ?? 0;
            const canPrev  = () => !playing() && slotPat() > 0;
            const canNext  = () => !playing();
            const canIns   = () => !playing() && s().songLength < s().orders.length;
            const canDel   = () => !playing() && s().songLength > 1;
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
                  >‹</button>
                  <button
                    type="button"
                    onClick={stepNextPattern}
                    disabled={!canNext()}
                    title="Next pattern at slot (>)"
                    aria-label="Next pattern at slot"
                  >›</button>
                  <button
                    type="button"
                    onClick={insertOrderSlot}
                    disabled={!canIns()}
                    title="Insert slot at cursor (⌘I)"
                    aria-label="Insert slot"
                  >+</button>
                  <button
                    type="button"
                    onClick={deleteOrderSlot}
                    disabled={!canDel()}
                    title="Delete slot at cursor (⌘D)"
                    aria-label="Delete slot"
                  >−</button>
                  <button
                    type="button"
                    onClick={newBlankPatternAtOrder}
                    disabled={!canBlank()}
                    title="New blank pattern at slot (⌘B)"
                    aria-label="New blank pattern"
                  >New</button>
                  <button
                    type="button"
                    onClick={duplicateCurrentPattern}
                    disabled={!canBlank()}
                    title="Duplicate pattern at slot (⌘⇧B)"
                    aria-label="Duplicate pattern"
                  >Dup</button>
                </div>
                <ol class="orderlist">
                  {s().orders.slice(0, s().songLength).map((p, i) => (
                    <li
                      classList={{
                        'orderlist__item--active': i === playPos().order,
                        'orderlist__item--cursor': transport() !== 'playing' && i === cursor().order,
                      }}
                      onClick={() => jumpToOrder(i)}
                      title={`Jump to order ${i}`}
                    >
                      <span class="num">{String(i).padStart(3, '0')}</span>
                      <span class="pat">{String(p).padStart(2, '0')}</span>
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
