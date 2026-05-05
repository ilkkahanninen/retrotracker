# Architecture overview

RetroTracker is a single-page Solid app built around an Amiga-Paula emulator and a strict ProTracker M.K. data model. The codebase splits cleanly along three axes:

1. **Domain core** ([src/core/](../src/core/)) — pure TypeScript, no DOM, no `AudioContext`. Contains the replayer, mixers, MOD parser/writer, mutations, and the sample pipeline. Everything is testable on Node.
2. **State** ([src/state/](../src/state/)) — Solid signals and the orchestration glue (transport, history, persistence, settings). Reactive surface that the UI binds to.
3. **UI** ([src/App.tsx](../src/App.tsx) + [src/components/](../src/components/)) — Solid components rendering the pattern grid, sample editor, chiptune editor, etc.

```
┌──────────────────────────────────────────────────────────────────────┐
│ UI layer (Solid components)                                          │
│   App.tsx  PatternGrid  SampleView  ChiptuneEditor  PipelineEditor   │
└─────┬──────────────────┬─────────────────────┬───────────────────────┘
      │ reads/writes     │ reads               │ commits edits
      ▼                  ▼                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ State (state/*) — Solid signals + orchestration                      │
│   song · cursor · selection · transport · workbenches · settings · … │
│   history (commitEdit, undo, redo)                                   │
│   playback (ensureEngine, playFrom*, stop)                           │
│   persistence (localStorage session)                                 │
└─────┬──────────────────┬─────────────────────┬───────────────────────┘
      │ Song             │ load/play           │ runPipeline
      ▼                  ▼                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Domain core (core/*) — pure, side-effect-free                        │
│                                                                      │
│   mod/        parser · writer · types · format · mutations           │
│              clipboardOps · flatten · sampleImport · sampleSelection │
│                                                                      │
│   audio/      replayer  ←────────────  Mixer interface               │
│                  │                       ├── Paula (live, BLEP+RC)   │
│                  │                       └── CleanMixer (bounce)     │
│                  ├── engine.ts (main thread wrapper)                 │
│                  ├── worklet.ts (AudioWorkletProcessor)              │
│                  ├── preview-worklet.ts (sample audition)            │
│                  └── offlineRender.ts (test bed + CLI)               │
│              sampleWorkbench · chiptune · shapers · wav · bounce     │
└──────────────────────────────────────────────────────────────────────┘
```

## Top-level invariants

These constraints are load-bearing — break them and the build burns.

- **Strict M.K. only.** [parser.ts](../src/core/mod/parser.ts) throws on any signature other than `M.K.`. There is no xCHN / FLT4 / FLT8 path; the data model assumes `CHANNELS === 4`.
- **One replayer, two drivers.** [replayer.ts](../src/core/audio/replayer.ts) has no DOM dependency, no `AudioContext` reference, no global sample rate. The same instance powers the worklet (live) and the offline renderer (tests, CLI). Don't fork mixing logic into the worklet.
- **Mixing lives behind the `Mixer` interface.** [mixer.ts](../src/core/audio/mixer.ts) defines the DMA-shaped contract; [paula.ts](../src/core/audio/paula.ts) is the analog-character implementation; [cleanMixer.ts](../src/core/audio/cleanMixer.ts) is the bounce-friendly clean resampler. The replayer never branches on which one is active.
- **Effect behavior matches pt2-clone.** Reference is [8bitbubsy/pt2-clone](https://github.com/8bitbubsy/pt2-clone), not OpenMPT. Quirks (decimal-encoded `Dxx`, period clamp 113..856, `EC0` cuts at tick 0, `Fxx` tempo deferred 1 tick, etc.) are preserved on purpose. See the comment block at the top of [replayer.ts](../src/core/audio/replayer.ts).
- **The `Song` is immutable.** Every edit returns a new `Song` reference (see [mutations.ts](../src/core/mod/mutations.ts)); unchanged rows/patterns are reference-shared so undo/redo snapshots are cheap. UI re-renders are gated on the song reference, not deep equality.
- **Workbenches are session-only.** The sample-editing chain in [SampleWorkbench](../src/core/audio/sampleWorkbench.ts) lives outside the `Song`. It survives the lifetime of the editing session (and partially through the localStorage session — chiptune params and source WAVs persist), but a `.mod` save round-trips only the resulting int8 data.

## Lifecycle of an edit

A pattern-cell edit illustrates the flow:

1. **UI keypress** in [PatternGrid.tsx](../src/components/PatternGrid.tsx) → keybinding handler in [appKeybinds.ts](../src/state/appKeybinds.ts).
2. **Mutation** — `commitEdit(s => setCell(s, cursor, ...))` in [state/song.ts](../src/state/song.ts) calls a pure mutation from [mutations.ts](../src/core/mod/mutations.ts), pushes a snapshot onto the past stack, and replaces the song signal.
3. **Reactive fan-out** — `dirty` flips to true (drives the unsaved-changes prompt). The pattern grid and the order list re-render off the new `song()` reference. The transport-aware bits (channel-level meters, playhead) keep running off whatever the worklet is mixing.
4. **Persistence side effect** — a `createEffect` in [persistence.ts](../src/state/persistence.ts) writes the new session to localStorage (debounced).
5. **Playback side effect** — if the user hits Play next, [playback.ts](../src/state/playback.ts) ensures the engine, calls `engine.load(song())` (which goes through `songForPlayback` to apply the loop-truncate fix-up — see [audio-engine.md](audio-engine.md)), and dispatches `play`. The worklet rebuilds its internal `Replayer` from the fresh song.

Sample-pipeline edits are similar but use `commitEditWithWorkbenches` so the workbench map and the song's int8 data move together — without that, undoing an effect would desync the chain UI from the waveform.

## Where each big idea lives

| Topic                               | Read first                                                                |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Tracker logic & effect quirks       | [src/core/audio/replayer.ts](../src/core/audio/replayer.ts)               |
| Paula DMA / BLEP / filters          | [src/core/audio/paula.ts](../src/core/audio/paula.ts)                     |
| Worklet ↔ main thread protocol      | [src/core/audio/worklet.ts](../src/core/audio/worklet.ts) + `engine.ts`   |
| MOD binary format                   | [src/core/mod/parser.ts](../src/core/mod/parser.ts) / `writer.ts`         |
| Pattern editing primitives          | [src/core/mod/mutations.ts](../src/core/mod/mutations.ts)                 |
| Pattern flatten (order → flat rows) | [src/core/mod/flatten.ts](../src/core/mod/flatten.ts)                     |
| Loop quirk fix-up                   | [src/core/audio/loopTruncate.ts](../src/core/audio/loopTruncate.ts)       |
| Sample pipeline (edit chain)        | [src/core/audio/sampleWorkbench.ts](../src/core/audio/sampleWorkbench.ts) |
| Chiptune synth                      | [src/core/audio/chiptune.ts](../src/core/audio/chiptune.ts)               |
| Bounce selection → sample           | [src/core/audio/bounce.ts](../src/core/audio/bounce.ts)                   |
| Undo / redo                         | [src/state/song.ts](../src/state/song.ts) (`commitEdit`, `undo`, `redo`)  |
| Session persistence                 | [src/state/persistence.ts](../src/state/persistence.ts)                   |
| Transport orchestration             | [src/state/playback.ts](../src/state/playback.ts)                         |
| Accuracy test bed                   | [tests/render-accuracy.test.ts](../tests/render-accuracy.test.ts)         |

## Build & dev pipeline

- Bundler: [Vite](../vite.config.ts) with `vite-plugin-solid`.
- Type checking: `tsc -b` (project-references mode); `noUncheckedIndexedAccess` is on.
- Path alias: `~/*` → `src/*` (configured in [tsconfig.json](../tsconfig.json) and [vitest.config.ts](../vitest.config.ts)).
- Worklet bundling: imports use the `?worker&url` suffix so Vite emits the worklet as a separate bundle and gives back a URL we can pass to `audioWorklet.addModule()`. Both [worklet.ts](../src/core/audio/worklet.ts) and [preview-worklet.ts](../src/core/audio/preview-worklet.ts) are loaded this way.

See [testing.md](testing.md) for the accuracy harness (`npm test`) and [audio-engine.md](audio-engine.md) for the runtime path.
