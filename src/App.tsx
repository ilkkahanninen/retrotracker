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

  const togglePlay = async () => {
    if (transport() === 'playing') {
      engine?.stop();
      setTransport('ready');
      return;
    }
    if (!song()) return;
    const eng = await ensureEngine();
    await eng.play();
    setTransport('playing');
  };

  /** Update the cursor with a movement function that needs the current Song. */
  const moveWithSong = (fn: (c: ReturnType<typeof cursor>, s: NonNullable<ReturnType<typeof song>>) => ReturnType<typeof cursor>) => {
    const s = song();
    if (!s) return;
    setCursor(fn(cursor(), s));
  };

  const cleanups: Array<() => void> = [];
  onMount(() => {
    cleanups.push(installShortcuts());
    cleanups.push(registerShortcut({
      key: ' ', description: 'Play / Stop', run: () => { void togglePlay(); },
    }));
    cleanups.push(registerShortcut({
      key: 'o', mod: true, description: 'Open .mod', run: openModPicker,
    }));
    // Cursor navigation
    cleanups.push(registerShortcut({
      key: 'arrowleft',  description: 'Cursor left',  run: () => setCursor(moveLeft(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowright', description: 'Cursor right', run: () => setCursor(moveRight(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowup',    description: 'Cursor up',    run: () => moveWithSong(moveUp),
    }));
    cleanups.push(registerShortcut({
      key: 'arrowdown',  description: 'Cursor down',  run: () => moveWithSong(moveDown),
    }));
    cleanups.push(registerShortcut({
      key: 'tab',                description: 'Next channel',     run: () => setCursor(tabNext(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'tab', shift: true,    description: 'Previous channel', run: () => setCursor(tabPrev(cursor())),
    }));
    cleanups.push(registerShortcut({
      key: 'pageup',   description: 'Page up',   run: () => moveWithSong((c, s) => pageUp(c, s, rowsPerBeat() * beatsPerBar())),
    }));
    cleanups.push(registerShortcut({
      key: 'pagedown', description: 'Page down', run: () => moveWithSong((c, s) => pageDown(c, s, rowsPerBeat() * beatsPerBar())),
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
