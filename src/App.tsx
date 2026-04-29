import type { Component } from 'solid-js';
import { song } from './state/song';

export const App: Component = () => {
  return (
    <div class="app">
      <header class="app__header">
        <h1>RetroTracker</h1>
        <div class="transport">
          <button disabled>Play</button>
          <button disabled>Stop</button>
        </div>
      </header>
      <aside class="app__samples">
        <h2>Samples</h2>
        <ol>
          {song.samples.map((s, i) => (
            <li>
              <span class="num">{String(i + 1).padStart(2, '0')}</span>
              <span class="name">{s.name || ' '}</span>
            </li>
          ))}
        </ol>
      </aside>
      <main class="app__pattern">
        <p class="placeholder">Pattern editor — coming soon.</p>
      </main>
      <aside class="app__order">
        <h2>Order</h2>
        <p class="placeholder">{song.songLength} positions</p>
      </aside>
    </div>
  );
};
