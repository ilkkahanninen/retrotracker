import { Show, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import {
  song, setSong, transport, setTransport, playPos, setPlayPos,
  canRedo, canUndo, clearHistory, redo, undo,
} from './state/song';
import { installShortcuts, registerShortcut } from './state/shortcuts';
import {
  cursor, setCursor, resetCursor,
  moveDown, moveLeft, moveRight, moveUp, pageDown, pageUp, tabNext, tabPrev,
} from './state/cursor';
import { beatsPerBar, rowsPerBeat } from './state/gridConfig';
import { parseModule } from './core/mod/parser';
import { AudioEngine } from './core/audio/engine';
import { PatternGrid } from './components/PatternGrid';

let engine: AudioEngine | null = null;

async function ensureEngine(): Promise<AudioEngine> {
  if (engine) return engine;
  engine = await AudioEngine.create();
  engine.onPosition = (order, row) => setPlayPos({ order, row });
  return engine;
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
      const eng = await ensureEngine();
      eng.load(mod);
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
    if (!song()) return;
    const eng = await ensureEngine();
    await eng.playFrom(0, 0);
    setTransport('playing');
  };

  const playFromCursor = async () => {
    if (!song()) return;
    const c = cursor();
    const eng = await ensureEngine();
    await eng.playFrom(c.order, c.row);
    setTransport('playing');
  };

  const playPatternFromStart = async () => {
    if (!song()) return;
    const c = cursor();
    const eng = await ensureEngine();
    await eng.playFrom(c.order, 0, { loopPattern: true });
    setTransport('playing');
  };

  const playPatternFromCursor = async () => {
    if (!song()) return;
    const c = cursor();
    const eng = await ensureEngine();
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

  const cleanups: Array<() => void> = [];
  onMount(() => {
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
          <button onClick={undo} disabled={!canUndo()} title="Undo (⌘Z)">
            Undo
          </button>
          <button onClick={redo} disabled={!canRedo()} title="Redo (⇧⌘Z)">
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
