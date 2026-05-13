# State management

The state layer lives in [src/state/](../src/state/) — every file there owns a piece of editor state, exposed as Solid signals plus a few action functions. The UI reads signals; the keyboard / menu handlers call the actions; reactive effects push downstream changes (worklet messages, localStorage writes).

The design rule: the UI should never reach into core. It always goes through state. That keeps mutations centralised, gives history a single funnel, and lets persistence stay keyed off the signals it cares about.

## The big signals

| Signal                                       | Owner file                                            | Type                                                      |
| -------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `song`                                       | [song.ts](../src/state/song.ts)                       | `Song \| null`                                            |
| `transport`                                  | [song.ts](../src/state/song.ts)                       | `'idle' \| 'ready' \| 'playing'`                          |
| `playMode`                                   | [song.ts](../src/state/song.ts)                       | `'song' \| 'pattern' \| null`                             |
| `playPos`                                    | [song.ts](../src/state/song.ts)                       | `{ order, row }`                                          |
| `dirty`                                      | [song.ts](../src/state/song.ts)                       | `boolean`                                                 |
| `cursor`                                     | [cursor.ts](../src/state/cursor.ts)                   | `{ order, row, channel, field }`                          |
| `selection`                                  | [selection.ts](../src/state/selection.ts)             | `PatternSelection \| null`                                |
| `clipboardSlice`                             | [clipboard.ts](../src/state/clipboard.ts)             | `Note[][] \| null`                                        |
| `currentSample`, `currentOctave`, `editStep` | [edit.ts](../src/state/edit.ts)                       | numbers                                                   |
| `view`                                       | [view.ts](../src/state/view.ts)                       | `'pattern' \| 'sample' \| 'info' \| 'settings'`           |
| `mutedChannels`, `soloedChannels`            | [channelMute.ts](../src/state/channelMute.ts)         | `readonly boolean[4]`                                     |
| `channelLevels`                              | [channelLevel.ts](../src/state/channelLevel.ts)       | `number[4]`                                               |
| `workbenches`                                | [sampleWorkbench.ts](../src/state/sampleWorkbench.ts) | `Map<slot, SampleWorkbench>`                              |
| `settings`                                   | [settings.ts](../src/state/settings.ts)               | `{ paulaModel, colorScheme, uiScale, stereoSeparation }`  |
| `patternNames`                               | [patternNames.ts](../src/state/patternNames.ts)       | `Record<patternIndex, string>`                            |
| `currentEngine`                              | [playback.ts](../src/state/playback.ts)               | `AudioEngine \| null` (reactive — sync effects subscribe) |

The table lists the PT-mode signals. XM mode has parallel signals (`xmCursor`, `xmSelection`, `xmClipboardSlice`, `currentXmInstrument`, `currentXmOctave`, `currentXmSampleIndex`, `xmWorkbenches`, `xmSampleSelection`) — same shapes, different cell types. Format is locked per project (`song.format` discriminates), so only one half is ever live; keeping them separate avoids stale state across project swaps.

## PT/XM shared factories

The editing logic itself is mostly factored out. The PT and XM state files instantiate generic factories with format-specific adapters:

| Factory                                                                                            | Used by                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createWorkbenchStore<K, V>()` ([workbenchStore.ts](../src/state/workbenchStore.ts))               | [sampleWorkbench.ts](../src/state/sampleWorkbench.ts), [xmSampleWorkbench.ts](../src/state/xmSampleWorkbench.ts)                     |
| `createSampleSelectionSignal()` ([sampleSelectionStore.ts](../src/state/sampleSelectionStore.ts))  | [sampleSelection.ts](../src/state/sampleSelection.ts), [xmSampleSelection.ts](../src/state/xmSampleSelection.ts)                     |
| `createRangedSignal()` ([editPrimitives.ts](../src/state/editPrimitives.ts))                       | [edit.ts](../src/state/edit.ts), [xmEdit.ts](../src/state/xmEdit.ts)                                                                 |
| `moveAlongFields`, `cycleChannel` ([cursorPrimitives.ts](../src/state/cursorPrimitives.ts))        | [cursor.ts](../src/state/cursor.ts), [cursorXm.ts](../src/state/cursorXm.ts) (field/tab wrap only — row movement is format-specific) |
| `createOrderEdit<S>(adapter)` ([orderEditCore.ts](../src/state/orderEditCore.ts))                  | [orderEdit.ts](../src/state/orderEdit.ts), [xmOrderEdit.ts](../src/state/xmOrderEdit.ts)                                             |
| `createPatternEdit<S, C, Cell>(adapter)` ([patternEditCore.ts](../src/state/patternEditCore.ts))   | [patternEdit.ts](../src/state/patternEdit.ts), [xmPatternEdit.ts](../src/state/xmPatternEdit.ts)                                     |
| `makePipelineActions<W>(host)` ([samplePipeline.ts](../src/state/samplePipeline.ts))               | [sampleEdit.ts](../src/state/sampleEdit.ts), [xmSampleEdit.ts](../src/state/xmSampleEdit.ts)                                         |
| `PIANO_KEYS`, `HEX_KEYS`, `DIGIT_QUICK_PICK` ([keybindHelpers.ts](../src/state/keybindHelpers.ts)) | [appKeybinds.ts](../src/state/appKeybinds.ts), [appKeybindsXm.ts](../src/state/appKeybindsXm.ts)                                     |

When extending behavior: most operations belong in the core factories; only format-specific quirks (PT period clamp, XM volume column nibbles, XM extended effect codes G..X, PT's Dxx-aware row navigation, XM's per-pattern row count) go in the per-format file.

## Edit history

[song.ts](../src/state/song.ts) owns undo/redo. Each commit pushes a snapshot tuple onto the past stack and replaces the live signals.

```ts
// Push a new song. Pattern names and workbenches carry across unchanged.
commitEdit(song => setCell(song, ...));

// Push a new song AND a new workbench map atomically. Used by sample-pipeline
// edits — without this, an undo of an effect would leave the chain UI at the
// post-edit state while the waveform reverted.
commitEditWithWorkbenches(state => ({
  song: ...,
  workbenches: withWorkbench(state.workbenches, slot, nextWb),
  patternNames: state.patternNames,
}));

undo();
redo();
canUndo();  // boolean
canRedo();
clearHistory();   // call after loading a new file
```

Snapshots are `{ song, workbenches, patternNames }` — three pieces that move together so a pattern-rename, an order edit, and a sample-pipeline tweak can all undo cleanly.

Constraints baked into commit:

- **No-ops are detected by reference.** If the transform returns the same `song` AND the same `workbenches` AND the same `patternNames`, nothing is pushed. This relies on mutations being immutable and reference-sharing unchanged structure.
- **Two-tier playback policy.** `commitEdit` gates on `transport() === 'playing'` (so pattern-cell edits can't race the worklet while it mixes the same data). `commitEditWithWorkbenches` does **not** gate — sample-pipeline edits, sample-meta tweaks, song-title changes, and order-list edits all stay live during playback. `undo` / `redo` follow `commitEdit`'s rule (gated). The sample / order paths reach the audible side via the live-edit hot-swap (see [Live edits during playback](audio-engine.md#live-edits-during-playback)); the worklet keeps its own song snapshot, so even without a hot-swap the on-screen state can move ahead of audio without desync risk.
- **History is capped.** `HISTORY_LIMIT = 200`. Older entries fall off the bottom; loading a new file calls `clearHistory()` so undo never crosses files.

### Drag-coalesced edits

Slider drags and waveform-handle drags fire dozens or hundreds of `commitEdit*` calls per second. Recording one undo entry per pointermove buries the user's "real" edits in noise, so [song.ts](../src/state/song.ts) exposes a coalescing pair:

```ts
beginDragEdit(); // open a group (call on pointerdown)
//   …commitEdit / commitEditWithWorkbenches fire freely; live state updates,
//     but the per-event history push is deferred…
endDragEdit(); // push exactly one entry covering the whole group (pointerup)
```

While the group is open, signals update normally — the user hears / sees every intermediate value live, the worklet's hot-swap forwarders still fire — only the history push is gated. The pre-group snapshot is taken at `beginDragEdit`; if `endDragEdit` finds nothing actually changed, no entry is recorded. [Slider.tsx](../src/components/Slider.tsx) wires this on `pointerdown` with a window-level `pointerup` so a release outside the thumb still closes the group, and a component-level `onCleanup` closes it if the slider unmounts mid-drag (otherwise `dragSnapshot` would stick and silently swallow every subsequent commit's undo entry).

Begins are idempotent: a second `beginDragEdit` while a group is open is a no-op. The first `endDragEdit` closes the group, so truly nested drags (e.g. multitouch on two controls) aren't supported — single-pointer flows are.

`dirty` is conservative: any commit / undo / redo sets it true. Returning to the saved state via undo doesn't auto-clean, because comparing to a saved snapshot would mean keeping that snapshot around — not worth the bookkeeping vs. an occasional unnecessary "discard?" prompt.

## Cursor

[cursor.ts](../src/state/cursor.ts) — the editing position in the pattern grid:

```ts
type Field =
  | "note"
  | "sampleHi"
  | "sampleLo"
  | "effectCmd"
  | "effectHi"
  | "effectLo";
interface Cursor {
  order: number;
  row: number;
  channel: number;
  field: Field;
}
```

Pure movement helpers (`moveLeft`, `moveRight`, `moveUp`, `moveDown`, `pageUp`, `pageDown`, `tabNext`, `tabPrev`) take a cursor + (optionally) a song and return a new cursor. Up/Down navigate the **flat list** ([flatten.ts](../src/core/mod/flatten.ts)) so reaching the last visible row of a pattern walks into the next pattern naturally. Hidden rows (Dxx-truncated) snap to the closest visible row at-or-before the cursor.

`jumpRequest` is a monotonic counter the PatternGrid subscribes to. Discrete jumps (clicking an order slot, inserting a slot) bump it; arrow / page navigation doesn't. The grid scrolls cursor → top whenever the counter ticks.

## Selection & clipboard

[selection.ts](../src/state/selection.ts) holds `selection` and `selectionAnchor` — both pre-normalised so `start <= end`. Shift-arrows extend; Esc clears. The pattern grid renders the selection as a tinted rectangle.

[clipboard.ts](../src/state/clipboard.ts) holds an in-memory 2D `Note[][]` slice. There's no system-clipboard / text-encoding round-trip yet — copy/paste is intra-app only. Deeply copied via [clipboardOps.readSlice](../src/core/mod/clipboardOps.ts) so the clipboard never aliases live song cells.

## Transport orchestration

[playback.ts](../src/state/playback.ts) is the only place that constructs the `AudioEngine`. It does so lazily (`ensureEngine()`) so tests and SSR-style first paint don't fail trying to build an `AudioContext` before a user gesture.

```ts
ensureEngine(): Promise<AudioEngine | null>;   // null on jsdom or pre-gesture
currentEngine: () => AudioEngine | null;       // Solid signal accessor

playFromStart();      playFromCursor();
playPatternFromStart(); playPatternFromCursor();
togglePlaySong();    togglePlayPattern();
jumpPlaybackToOrder(order);             // mid-playback jump w/o stopping
stopPlayback();      stopEngine();
triggerPreview(slot, sample, period);
livePreviewSwap(slot, sample, period);  // mid-preview re-target (no click)
stopEnginePreview(); disposeEngine();
```

`currentEngine` is a Solid signal, not a plain accessor. Reactive effects that read it inside `createEffect` automatically re-run when the engine flips from `null` to a real instance — that's how cached preferences land in a freshly-built engine without any one-shot push at construction time. `ensureEngine` also dedupes through an in-flight `creating` promise so two near-simultaneous callers (e.g. preview + play firing in the same tick) don't both spin up an `AudioContext` and orphan one.

`jumpPlaybackToOrder` is the path the order-list click and the bare `[` / `]` shortcuts go through during playback: it snaps `playPos` synchronously (so the playhead UI moves on click instead of waiting for the next worklet `pos` event) and tells the engine to `playFrom(order, 0)` while keeping the current `playMode` (song / pattern-loop). It does **not** call `engine.load(song)`, so any sample edits hot-swapped into the worklet's snapshot survive the jump.

When the engine is created, `ensureEngine` only wires up the two callbacks:

- `engine.onPosition = (order, row) => setPlayPos(...)` — drives the playhead row tint.
- `engine.onLevels   = (peaks)       => setChannelLevels(peaks)` — drives VU meters.

The mute gate / Paula model / stereo-separation flow goes through [state/sync.ts](../src/state/sync.ts) (`installEngineSync()`, called once at App mount). Each forwarder reads `currentEngine()` inside its own `createEffect`, so the moment the engine signal flips non-null, all three effects re-run and push their cached values in. The same module also diffs `song.samples[i]` and `song.orders` / `song.patterns` / `song.songLength` by reference and forwards changes via `engine.setSampleData` / `engine.replaceSong` while the transport is playing — see [Live edits during playback](audio-engine.md#live-edits-during-playback).

### Sample preview

Preview audio runs through a separate `AudioWorklet` voice (the "preview worklet"). [state/preview.ts](../src/state/preview.ts) tracks visual state (which slot is auditioning, when the preview started — used by the sample editor's animated playhead). The audio side goes through `engine.previewNote` and `engine.stopPreview`. `livePreviewSwap` re-targets a held-key preview when the underlying sample is edited mid-audition (synth slider drags, pipeline param tweaks).

## Settings

[settings.ts](../src/state/settings.ts) — preferences that outlive any single file:

```ts
interface Settings {
  paulaModel: "A500" | "A1200";
  colorScheme: "default" | "light" | "high-contrast" | "amber";
  uiScale: number; // 75..150 percent
  stereoSeparation: number; // 0..100 percent
}
```

Stored in its own localStorage key (`retrotracker:settings:v1`) so settings travel with the user, not the song. Missing keys fall back to defaults so older saved settings forward-compat without a version bump.

## Persistence

[persistence.ts](../src/state/persistence.ts) — localStorage session round-trip. The song itself goes through `writeModule` / `parseModule` (binary M.K. base64'd) so the persistence path matches "Save .mod" exactly — no JSON shape to migrate when the format gets a feature.

What persists:

- The song bytes (lossless via the binary writer).
- Cursor, view, current sample / octave / edit step, filename, info text.
- Pattern names (project-only state).
- **Chiptune sources** — tiny `ChiptuneParams` JSON. The synth is deterministic, so re-running it reproduces the int8 exactly.
- **Sampler sources** — 16-bit PCM WAV bytes (base64). Heavy enough that a single autosave can blow the localStorage quota; `saveSession` swallows that silently and the user falls back to explicit Save.
- **Per-channel mute / solo** — 4-element boolean arrays. Restored by both the `.retro` upload path (`applyLoadedSession`) and the autosave path (`onMount` after `loadSession`).

What doesn't persist:

- History stacks (`clearHistory()` on every load — fresh session, no undo across files).
- Selection, clipboard, transport, playPos (all ephemeral).

Schema versions are baked into the storage key (`v1` for the key itself) and the payload (`v: 1..5`). Each version adds an optional field: v=2 chiptuneSources, v=3 samplerSources, v=4 patternNames, v=5 mutedChannels/soloedChannels. Newer writes use the lowest version that fits the data — a project that uses none of those still emits v=1, so older readers stay forward-compatible.

## Sample workbenches

[state/sampleWorkbench.ts](../src/state/sampleWorkbench.ts) holds the `Map<slot, SampleWorkbench>` for sample-editing chains. The map is wrapped in a Solid signal of a fresh Map per write because Solid doesn't track Map mutations deeply.

Action surface:

```ts
getWorkbench(slot): SampleWorkbench | undefined;
setWorkbench(slot, wb);                  // direct write (no history snapshot)
clearWorkbench(slot);
clearAllWorkbenches();                   // called on .mod load

// Pure helpers for commitEditWithWorkbenches:
withWorkbench(map, slot, wb): WorkbenchMap;
withoutWorkbench(map, slot): WorkbenchMap;
```

The "raw" setter (`setWorkbenchesRaw`) is exported so the song-history code in `state/song.ts` can snapshot/restore the map alongside the song — that's how undo/redo of a workbench edit reverts the chain UI atomically with the waveform. App-level handlers go through `commitEditWithWorkbenches` instead.

## Smaller pieces

| File                                                  | What it owns                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [edit.ts](../src/state/edit.ts)                       | `currentSample` (1..31), `currentOctave` (1..3), `editStep` (rows to advance after note entry)              |
| [view.ts](../src/state/view.ts)                       | `view` ('pattern' \| 'sample' \| 'info' \| 'settings')                                                      |
| [io.ts](../src/state/io.ts)                           | Loaded filename, helpers for "Save As" naming                                                               |
| [theme.ts](../src/state/theme.ts)                     | Reactive binding from `settings.colorScheme` to CSS variables                                               |
| [keyboardLayout.ts](../src/state/keyboardLayout.ts)   | Note-entry layout (QWERTY, Dvorak, etc.) and the row→note mapping                                           |
| [shortcuts.ts](../src/state/shortcuts.ts)             | The user-facing keybinding model (used by [PatternHelp](../src/components/PatternHelp.tsx))                 |
| [appKeybinds.ts](../src/state/appKeybinds.ts)         | The actual keydown router — translates events to actions                                                    |
| [platform.ts](../src/state/platform.ts)               | `isMac()` for ⌘ vs. Ctrl decisions                                                                          |
| [info.ts](../src/state/info.ts)                       | The "info" text editor's state (stored in `.retro`, never in `.mod`)                                        |
| [gridConfig.ts](../src/state/gridConfig.ts)           | Pattern-grid display preferences (row-hex highlighting cadence)                                             |
| [channelLevel.ts](../src/state/channelLevel.ts)       | Per-channel peak amplitudes for the VU meters                                                               |
| [channelMute.ts](../src/state/channelMute.ts)         | Mute / solo flags. `isChannelMuted(ch)` combines both: any solo wins, else mute decides                     |
| [patternNames.ts](../src/state/patternNames.ts)       | User-given pattern names (project-only — never written to .mod)                                             |
| [sync.ts](../src/state/sync.ts)                       | `installEngineSync()` — one-stop reactive forwarder of mute / model / song shape to the audio engine        |
| [session.ts](../src/state/session.ts)                 | `loadFile`, `saveProject`, `exportMod`, `exportWav`, `applyLoadedSession`, `newProject`, `error`/`filename` |
| [patternEdit.ts](../src/state/patternEdit.ts)         | Pattern-grid action handlers (note entry, hex digit, transpose, paste, selection step, channel mute/solo)   |
| [sampleEdit.ts](../src/state/sampleEdit.ts)           | Sample-pipeline action handlers (load WAV, add/move/patch/remove effect, source kind toggle, target note)   |
| [orderEdit.ts](../src/state/orderEdit.ts)             | Order-list action handlers (jump, prev/next pattern at slot, insert/delete slot, new/duplicate, clean up)   |
| [dropImport.ts](../src/state/dropImport.ts)           | Multi-WAV drop import — fans new WAVs across free sample slots in one history entry                         |
| [loopStash.ts](../src/state/loopStash.ts)             | Per-slot stash of the loop bounds the user had configured before disabling loop, restored on re-enable      |
| [sampleSelection.ts](../src/state/sampleSelection.ts) | Range selection inside a sample's waveform (used by SampleView)                                             |
| [preview.ts](../src/state/preview.ts)                 | Visual playhead state for the sample-editor preview (separate from the audio side of `engine.previewNote`)  |

## Reactivity rules of thumb

- Signals are not nested deep stores. The `Song`, the `WorkbenchMap`, etc. are wholly replaced on each write — components compare references with Solid's default equality. That's why mutations short-circuit to the input reference when nothing changed: it preserves zero-cost re-render skipping.
- Side effects belong in `createEffect` blocks at App-component scope, not at module scope (no reactive root there). Settings persistence is the exception — it uses a write-through wrapper rather than an effect.
- The transport state lives **separately from the engine**. The engine is the audio side; `transport` / `playMode` / `playPos` are the UI side. They're synced explicitly in [playback.ts](../src/state/playback.ts) so a transport-state change never depends on an engine round-trip.
