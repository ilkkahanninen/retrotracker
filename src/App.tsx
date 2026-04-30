import { Show, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import {
  song, setSong, transport, setTransport, playPos, setPlayPos,
  canRedo, canUndo, clearHistory, commitEdit, redo, undo,
} from './state/song';
import { installShortcuts, registerShortcut } from './state/shortcuts';
import {
  cursor, setCursor, resetCursor,
  moveDown, moveLeft, moveRight, moveUp, pageDown, pageUp, tabNext, tabPrev,
} from './state/cursor';
import { beatsPerBar, rowsPerBeat } from './state/gridConfig';
import { clearFieldPatch, currentOctave, currentSample, octaveDown, octaveUp } from './state/edit';
import { parseModule } from './core/mod/parser';
import { PERIOD_TABLE, emptySong } from './core/mod/format';
import { deleteCellPullUp, insertCellPushDown, setCell } from './core/mod/mutations';
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
    for (const [k, offset] of Object.entries(PIANO_KEYS)) {
      cleanups.push(registerShortcut({
        key: k,
        description: `Note (offset ${offset})`,
        run: () => enterNote(offset),
        runUp: () => engine?.stopPreview(),
      }));
    }
    cleanups.push(registerShortcut({
      key: 'z', description: 'Octave down', run: octaveDown,
    }));
    cleanups.push(registerShortcut({
      key: 'x', description: 'Octave up', run: octaveUp,
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
                <li classList={{ 'sample--empty': sample.lengthWords === 0 }}>
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
          {(s) => (
            <ol class="orderlist">
              {s().orders.slice(0, s().songLength).map((p, i) => (
                <li classList={{ 'orderlist__item--active': i === playPos().order }}>
                  <span class="num">{String(i).padStart(3, '0')}</span>
                  <span class="pat">{String(p).padStart(2, '0')}</span>
                </li>
              ))}
            </ol>
          )}
        </Show>
      </aside>
    </div>
  );
};
