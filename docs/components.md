# UI components

The UI is small by tracker standards: one root component (`App`), four top-level views (`pattern`, `sample`, `info`, `settings`), and a handful of focused panes that fill them. Solid handles the reactivity; the components themselves are mostly view + small handlers that delegate to state actions.

## Layout

[src/App.tsx](../src/App.tsx) is the root (~1k lines). It mounts at [src/main.tsx](../src/main.tsx) and is now a thin shell — the meat of the editor (pattern editing, sample-pipeline editing, order-list editing, multi-WAV drop, file I/O) lives in [state/patternEdit.ts](../src/state/patternEdit.ts), [state/sampleEdit.ts](../src/state/sampleEdit.ts), [state/orderEdit.ts](../src/state/orderEdit.ts), [state/dropImport.ts](../src/state/dropImport.ts), and [state/session.ts](../src/state/session.ts). App owns:

- The menu bar (File / Edit) plus the song / pattern transport buttons.
- The `view` tab strip (`pattern` / `sample` / `info` / `settings`) wired to F2..F5 shortcuts.
- The grid layout — three CSS columns in pattern view (samples · main · order list), two in sample view (samples · main), and main-only in info / settings (no sample list aside). The view signal flips a class (`.app--view-pattern` / `.app--view-sample` / `.app--view-info` / `.app--view-settings`) on the root, and `grid-template-columns` switches accordingly.
- All keyboard wiring — `installShortcuts` + `registerAppKeybinds` from [state/shortcuts.ts](../src/state/shortcuts.ts) and [state/appKeybinds.ts](../src/state/appKeybinds.ts), with App passing the action functions in.
- File I/O glue — drag-drop (single `.mod` / `.retro` replaces the project; multi-WAV fans into free slots via [dropImport.ts](../src/state/dropImport.ts)) and File menu entries (New, Open, Save, Export .mod, Export .wav).
- Engine-sync registration via `installEngineSync()` from [state/sync.ts](../src/state/sync.ts) (the actual reactive forwarders live there).
- Two small UI-local pieces of state: `editingTitle` (song-title inline editor) and `editingOrderIdx` (order-row inline rename). Everything else lives in `state/`.
- The autosave `createEffect` (debounced 250 ms) that writes the session through [state/persistence.ts](../src/state/persistence.ts) on every tracked-signal change.
- Two header memos for byte-size readouts: `modByteSize` (live `.mod` length) and `projectByteSize` (estimated `.retro` size, with warn / error thresholds at 4 / 5 MB).

All four panes stay mounted simultaneously and are toggled with a `view-hidden` class — toggling unmount/mount used to rebuild ~2400 PatternGrid spans on every view switch, which the user felt as a noticeable lag.

## Top-level panes

| Component                                                  | Purpose                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SampleList.tsx](../src/components/SampleList.tsx)         | Sample slot picker (1..31). Always visible — shared by pattern and sample views. Lists each slot's name + length, highlights the current sample. Click selects, double-click opens the sample view, in-place rename.                                                      |
| [PatternGrid.tsx](../src/components/PatternGrid.tsx)       | Pattern editor — the heart of the pattern view. Renders the flattened row list with cursor + selection highlighting + playhead tint, channel headers (mute/solo, VU meter), row numbers. Uses `flattenSong` so pattern boundaries appear inline.                          |
| [PatternHelp.tsx](../src/components/PatternHelp.tsx)       | Right rail of the pattern view. Shows the active row's effects, the current cell's keybinding hints, and live status (next note that key would enter, current octave, edit step).                                                                                         |
| [SampleView.tsx](../src/components/SampleView.tsx)         | Sample editor — the heart of the sample view. Hosts the [Waveform.tsx](../src/components/Waveform.tsx) canvas (with selection range, loop bounds, animated playhead during preview), sample metadata (name, finetune, volume, target note), and the source/output picker. |
| [PipelineEditor.tsx](../src/components/PipelineEditor.tsx) | Effect chain UI. Add / remove / reorder effects, edit their params, toggle bypass. Each effect kind has its own param widget set (filter cutoff, fade range, shaper amount, …). Drives `commitEditWithWorkbenches`.                                                       |
| [ChiptuneEditor.tsx](../src/components/ChiptuneEditor.tsx) | Wavetable-synth UI. Two oscillator panels (shape, phase split, ratio), combine mode + amount, single LFO with target picker, post-combine shaper. Slider drags fire `livePreviewSwap` so the audition voice morphs in real time.                                          |
| [Waveform.tsx](../src/components/Waveform.tsx)             | Canvas renderer for sample data. Re-uses the same view in pipeline thumbnails. Cursor-driven selection, click-to-set loop bounds, animated playhead during preview.                                                                                                       |
| [InfoView.tsx](../src/components/InfoView.tsx)             | The "info" text editor — author notes that travel with `.retro` projects but never with `.mod` files.                                                                                                                                                                     |
| [SettingsView.tsx](../src/components/SettingsView.tsx)     | Settings panel: Paula model (A500 / A1200), color scheme, UI scale slider, stereo separation slider. Reads/writes `settings()` from [state/settings.ts](../src/state/settings.ts).                                                                                        |
| [Menu.tsx](../src/components/Menu.tsx)                     | Reusable menu-bar dropdown. Used by App for File and Edit.                                                                                                                                                                                                                |
| [Slider.tsx](../src/components/Slider.tsx)                 | Reusable horizontal slider for numeric params. Wraps each pointerdown..pointerup gesture in `beginDragEdit` / `endDragEdit` so the drag's many `commitEdit*` calls collapse into one undo entry. Used by the chiptune editor and pipeline editor.                         |
| [hooks.ts](../src/components/hooks.ts)                     | Shared Solid hooks (`useWindowListener` etc.) — small enough to keep in one file.                                                                                                                                                                                         |

## Pattern grid internals

[PatternGrid.tsx](../src/components/PatternGrid.tsx) is the most CPU-sensitive UI component. The implementation choices that keep it cheap:

- **Renders from a flattened list** ([flatten.ts](../src/core/mod/flatten.ts)) — one virtual list, not a per-pattern stack. Solid's `For` reconciles by row reference; `flattenSong` caches `FlatRow` objects by cell reference, so a one-cell edit only re-renders that row. Pattern boundaries appear inline as marker rows.
- **Cursor render is a single tinted overlay** keyed off `(order, row, channel, field)`, not part of every row's render.
- **Playhead is a separate tint layer** keyed off `playPos()`, also not per-row.
- **Selection rectangle is a single styled element** computed from `selection()`.
- **Margin-driven scroll** — `cursor()` changes only scroll the grid when the cursor crosses a margin. `jumpRequest()` (from [cursor.ts](../src/state/cursor.ts)) bumps when the user makes a discrete jump (clicked an order slot, inserted a slot) to opt into "snap cursor → top" instead.
- **Per-cell hex-or-dec rendering** is done by lookup tables (`NOTE_NAMES`, `sampleChars`) — no string interpolation per render.

Header of the grid hosts:

- Per-channel mute / solo toggles (shift-click for solo).
- Per-channel VU meters (drives off `channelLevels()`, throttled by the worklet's ~30 Hz reporting cadence).

The shared `currentSample()` from [state/edit.ts](../src/state/edit.ts) determines which sample the user is auditioning when they preview a row by holding shift on the cursor.

## Sample view internals

[SampleView.tsx](../src/components/SampleView.tsx) is the host. The piece composition:

- **Source picker** — switch between Sampler (loaded WAV) and Chiptune (synthesised cycle). The empty source option creates a workbench from `emptySamplerWorkbench`.
- **Waveform** — the canvas renderer. Click + drag selects a sample range; double-click sets loop bounds; pan + zoom via scroll. The animated playhead reads off `preview()` state from [state/preview.ts](../src/state/preview.ts).
- **PipelineEditor** — only when a workbench exists.
- **ChiptuneEditor** — only when the source is `kind: 'chiptune'`.
- **Sample metadata fields** — name, finetune, volume, loop start / length. Edits go through `setSample` mutation.

Holding shift on the keyboard while pressing a note key auditions through the preview worklet ([state/preview.ts](../src/state/preview.ts) + [audio/preview-worklet.ts](../src/core/audio/preview-worklet.ts)).

## CSS

Styling lives in [src/index.css](../src/index.css) — a single sheet, ~1000 lines, organized by section. There's no CSS-in-JS or Tailwind; design tokens are CSS custom properties (`--color-bg`, `--cell-h`, etc.) defined per color scheme. [state/theme.ts](../src/state/theme.ts) writes the current scheme's variables onto `:root`, and [SettingsView.tsx](../src/components/SettingsView.tsx) writes the UI scale to a root variable that the layout multiplies into all `em` measurements.

## Where the action handlers live

App.tsx imports its action functions from `state/`:

| Surface               | Module                                              | What's in it                                                                                                                                   |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pattern-grid edits    | [state/patternEdit.ts](../src/state/patternEdit.ts) | Note entry, hex digit, transpose, paste, channel mute/solo, cursor + selection step helpers, `applyCursor` / `extendSelection` committing path |
| Sample-pipeline edits | [state/sampleEdit.ts](../src/state/sampleEdit.ts)   | Add / move / patch / remove effect, source-kind toggle, target-note / mono-mix / resample / dither, load WAV, crop / cut / duplicate / clear   |
| Order-list edits      | [state/orderEdit.ts](../src/state/orderEdit.ts)     | Jump to order, prev/next pattern at slot, insert / delete / new / duplicate, clean-up renumber                                                 |
| Multi-WAV drop        | [state/dropImport.ts](../src/state/dropImport.ts)   | `loadWavsIntoFreeSlots` — fans dropped WAVs across free slots in one undo entry                                                                |
| File I/O & export     | [state/session.ts](../src/state/session.ts)         | `loadFile`, `saveProject`, `exportMod`, `exportWav`, `applyLoadedSession`, `newProject`, the source-snapshot helpers                           |
| Engine sync           | [state/sync.ts](../src/state/sync.ts)               | `installEngineSync()` — reactive forwarders for mute, Paula model, stereo separation, `setSampleData`, `replaceSong`                           |

App stitches them together: it imports the actions, hands them to `registerAppKeybinds`, and passes the relevant ones into each pane component as props.
