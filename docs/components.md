# UI components

The UI is small by tracker standards: one root component (`App`), two top-level views (`pattern` and `sample`), and a handful of focused panes that fill them. Solid handles the reactivity; the components themselves are mostly view + small handlers that delegate to state actions.

## Layout

[src/App.tsx](../src/App.tsx) is the root. It mounts at [src/main.tsx](../src/main.tsx) and owns:

- The menu bar (File / Edit / playback controls).
- The `view` toggle (`'pattern'` ↔ `'sample'`) wired to keyboard shortcuts.
- The grid layout — three CSS columns in pattern view (samples · main · order list), two columns in sample view (samples · main). The toggle flips a class (`.app--view-pattern` / `.app--view-sample`) on the root, and the layout's `grid-template-columns` switches accordingly.
- All keyboard wiring — `installShortcuts` + `registerAppKeybinds` from [state/shortcuts.ts](../src/state/shortcuts.ts) and [state/appKeybinds.ts](../src/state/appKeybinds.ts).
- File I/O glue — drag-drop and File menu entries (Open .mod, Open .retro, Save .mod, Save .retro, New).
- Reactive effects that push setting changes into the audio engine.

The two big handler clusters in App are:

1. **Pattern editing** — `commitEdit(s => setCell(...))`, paste, transpose, etc. Selection-aware: when a selection exists, transposing or clearing applies to it; otherwise to the cursor.
2. **Sample-pipeline editing** — `commitEditWithWorkbenches` with `runPipeline` to materialise the new int8 alongside the workbench update.

## Top-level panes

| Component                                                          | Purpose                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [SampleList.tsx](../src/components/SampleList.tsx)                 | Sample slot picker (1..31). Always visible — shared by pattern and sample views. Lists each slot's name + length, highlights the current sample. Click selects, double-click opens the sample view, in-place rename. |
| [PatternGrid.tsx](../src/components/PatternGrid.tsx)               | Pattern editor — the heart of the pattern view. Renders the flattened row list with cursor + selection highlighting + playhead tint, channel headers (mute/solo, VU meter), row numbers. Uses `flattenSong` so pattern boundaries appear inline. |
| [PatternHelp.tsx](../src/components/PatternHelp.tsx)               | Right rail of the pattern view. Shows the active row's effects, the current cell's keybinding hints, and live status (next note that key would enter, current octave, edit step). |
| [SampleView.tsx](../src/components/SampleView.tsx)                 | Sample editor — the heart of the sample view. Hosts the [Waveform.tsx](../src/components/Waveform.tsx) canvas (with selection range, loop bounds, animated playhead during preview), sample metadata (name, finetune, volume, target note), and the source/output picker. |
| [PipelineEditor.tsx](../src/components/PipelineEditor.tsx)         | Effect chain UI. Add / remove / reorder effects, edit their params, toggle bypass. Each effect kind has its own param widget set (filter cutoff, fade range, shaper amount, …). Drives `commitEditWithWorkbenches`. |
| [ChiptuneEditor.tsx](../src/components/ChiptuneEditor.tsx)         | Wavetable-synth UI. Two oscillator panels (shape, phase split, ratio), combine mode + amount, single LFO with target picker, post-combine shaper. Slider drags fire `livePreviewSwap` so the audition voice morphs in real time. |
| [Waveform.tsx](../src/components/Waveform.tsx)                     | Canvas renderer for sample data. Re-uses the same view in pipeline thumbnails. Cursor-driven selection, click-to-set loop bounds, animated playhead during preview. |
| [InfoView.tsx](../src/components/InfoView.tsx)                     | The "info" text editor — author notes that travel with `.retro` projects but never with `.mod` files.                                |
| [SettingsView.tsx](../src/components/SettingsView.tsx)             | Settings panel: Paula model (A500 / A1200), color scheme, UI scale slider, stereo separation slider. Reads/writes `settings()` from [state/settings.ts](../src/state/settings.ts). |
| [Menu.tsx](../src/components/Menu.tsx)                             | Reusable menu-bar dropdown. Used by App for File and Edit.                                       |
| [Slider.tsx](../src/components/Slider.tsx)                         | Reusable horizontal slider for numeric params. Used in the chiptune editor and pipeline editor. |
| [hooks.ts](../src/components/hooks.ts)                             | Shared Solid hooks (`useWindowListener` etc.) — small enough to keep in one file.               |

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

## Why one giant `App.tsx`?

`App.tsx` is currently 100KB+. It's deliberately not split because:

- The handlers all share the same `commitEdit*` / `cursor` / `selection` closure environment, and Solid encourages co-locating logic with the component that owns the signal lifecycle.
- The pattern-edit handlers and the sample-pipeline handlers are tightly coupled to the keybinding map (`registerAppKeybinds`), which lives in `state/`. Splitting would just push the bridge code into more files.

When App grows beyond what `Cmd-F` can handle comfortably, the natural split is by view: pull all sample-pipeline handlers into a `SampleAppShell` component that hosts the sample view and owns the workbench commits.
