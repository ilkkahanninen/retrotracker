import { Show, createMemo, createSignal, onCleanup, type Component } from 'solid-js';
import { song, setSong, transport, setTransport } from './state/song';
import { parseModule } from './core/mod/parser';
import { AudioEngine } from './core/audio/engine';

let engine: AudioEngine | null = null;

async function ensureEngine(): Promise<AudioEngine> {
  if (engine) return engine;
  engine = await AudioEngine.create();
  engine.onEnded = () => setTransport('ready');
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
      setFilename(file.name);
      setTransport('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTransport('idle');
    }
  };

  const onPickFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
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

  const onPlay = async () => {
    if (!song()) return;
    const eng = await ensureEngine();
    await eng.play();
    setTransport('playing');
  };

  const onStop = () => {
    engine?.stop();
    setTransport('ready');
  };

  onCleanup(() => {
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
          <label class="file-button">
            <input type="file" accept=".mod" onChange={onPickFile} hidden />
            Load .mod…
          </label>
          <button onClick={onPlay} disabled={!song() || transport() === 'playing'}>
            Play
          </button>
          <button onClick={onStop} disabled={transport() !== 'playing'}>
            Stop
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
            <div class="songinfo">
              <h2>Loaded</h2>
              <dl>
                <dt>File</dt><dd>{filename()}</dd>
                <dt>Title</dt><dd>{s().title || <em>(untitled)</em>}</dd>
                <dt>Samples</dt><dd>{sampleCount()} / 31</dd>
                <dt>Length</dt><dd>{s().songLength} positions</dd>
                <dt>Patterns</dt><dd>{s().patterns.length}</dd>
                <dt>Status</dt><dd>{transport()}</dd>
              </dl>
              <p class="hint">Pattern editor coming soon. For now: Play to listen.</p>
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
                <li>
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
