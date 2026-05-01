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
} from './core/mod/mutations';
import { AudioEngine } from './core/audio/engine';
import { PatternGrid } from './components/PatternGrid';

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

async function ensureEngine(): Promise<AudioEngine> {
  if (engine) return engine;
  engine = await AudioEngine.create();
  engine.onPosition = (order, row) => setPlayPos({ order, row });
  return engine;
}

/**
 * Ensure the engine exists and push the current Song into it before play.
 * The worklet keeps its own copy of the song, so without this every edit
 * would only show up in the UI — the user would press Play and hear the
 * pre-edit version. Returns null if no song is loaded.
 */
async function prepareEngine(): Promise<AudioEngine | null> {
  const eng = await ensureEngine();
  const s = song();
  if (!s) return null;
  eng.load(s);
  return eng;
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
    if (sample && engine) void engine.previewNote(sample, period);
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
        when: () => transport() !== 'playing' && cursor().field === 'note',
        run: () => enterNote(offset),
        runUp: () => engine?.stopPreview(),
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
        when: () => transport() !== 'playing' && !isHexField(cursor().field),
        run: () => selectSample(n),
      }));
      cleanups.push(registerShortcut({
        key: k, shift: true,
        description: `Select sample ${n + 10}`,
        when: () => transport() !== 'playing',
        run: () => selectSample(n + 10),
      }));
    }
    cleanups.push(registerShortcut({
      key: '-',
      description: 'Previous sample',
      when: () => transport() !== 'playing',
      run: prevSample,
    }));
    cleanups.push(registerShortcut({
      key: '=',
      description: 'Next sample',
      when: () => transport() !== 'playing',
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
      classList={{ 'app--drag': dragOver() }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header class="app__header">
        <h1>RetroTracker</h1>
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
        <Show when={song()} fallback={<p class="placeholder">No song loaded</p>}>
          {(s) => (
            <ol>
              {s().samples.map((sample, i) => (
                <li
                  classList={{
                    'sample--empty':   sample.lengthWords === 0,
                    'sample--current': currentSample() === i + 1,
                  }}
                  onClick={() => selectSample(i + 1)}
                  title={`Select sample ${i + 1}`}
                >
                  <span class="num">{String(i + 1).padStart(2, '0')}</span>
                  <span class="name">{sample.name || '—'}</span>
                </li>
              ))}
            </ol>
          )}
        </Show>
      </aside>

      <main class="app__pattern">
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
          )}
        </Show>
      </main>

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
    </div>
  );
};
