# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RetroTracker is a web-based tracker (Solid + Vite + TypeScript) that edits both ProTracker `.mod` (strict 4-channel "M.K.", no xCHN/FLT4/etc.) and FastTracker 2 `.xm` (variable channel count, up to 128 instruments with nested samples, volume column, Gxx..Xxx extended effects). The Paula replayer is the centerpiece on the PT side; the XM path runs through a parallel mixer.

## Commands

```bash
npm run dev              # Vite dev server
npm run build            # tsc -b && vite build
npm run typecheck        # tsc -b --noEmit
npm test                 # vitest run (includes accuracy test bed)
npm run test:watch
npm run render -- in.mod out.wav [--seconds=N] [--rate=44100]   # offline render via our replayer
```

Run a single test file: `npx vitest run tests/render-accuracy.test.ts`. Filter by name: `npx vitest run -t "00-baseline"`.

Tests under `tests/ui/**` run in jsdom (mounting Solid components, simulating keypresses with `@testing-library/user-event`); everything else runs on node. The split is configured in [vitest.config.ts](vitest.config.ts) via `environmentMatchGlobs` — UI test files use the `.test.tsx` extension by convention. Module-level signals (`cursor`, `song`, `transport`, …) persist across tests in the same file, so reset them in `beforeEach`.

Fixture / reference workflow (see [tests/fixtures/README.md](tests/fixtures/README.md)):

```bash
npm run fixtures:generate    # rebuild .mod fixtures from generate.ts (deterministic)
npm run pt2-clone:build      # build vendor/bin/pt2-render (one-time, ~1s, clones pt2-clone)
npm run fixtures:render      # render every .mod → .reference.wav via pt2-render
```

The accuracy test auto-builds `vendor/bin/pt2-render` and any missing `.reference.wav` on first run, so a clean `npm test` works without these scripts. Reference WAVs are gitignored; `.mod` fixtures are committed.

## Architecture

### One Replayer, two drivers

[src/core/audio/replayer.ts](src/core/audio/replayer.ts) is a pure state machine — no DOM, no `AudioContext`, no `sampleRate` global. The same instance powers two consumers:

- **Live playback**: [src/core/audio/worklet.ts](src/core/audio/worklet.ts) (`AudioWorkletProcessor`) runs inside the audio thread. [src/core/audio/engine.ts](src/core/audio/engine.ts) is the main-thread wrapper that registers the worklet and proxies `load`/`play`/`stop` over `port.postMessage`. Vite bundles the worklet via `import workletUrl from './worklet?worker&url'`.
- **Offline render**: [src/core/audio/offlineRender.ts](src/core/audio/offlineRender.ts) loops `replayer.process()` into Float32 buffers in 1024-frame chunks. Used by the test bed and the `render` CLI ([tests/lib/render-cli.ts](tests/lib/render-cli.ts)).

When changing replayer behavior, both paths get it for free. Don't fork mixing logic into the worklet.

### Replayer model

`Replayer.process(left, right, frames, offset)` writes interleaved-by-buffer Float32 samples. Mixing is delegated to [Paula](src/core/audio/paula.ts), which does BLEP synthesis, RC + LED filters, and 2× FIR downsampling. The replayer alternates `mixChunk` (drives Paula) with `advanceTick` (per-tick effects, row advancement, song state). Tick scheduling uses CIA-timer math (`tickHz = 709379 / (floor(1773447/BPM)+1)`) with a fractional-sample accumulator to match pt2-clone's exact timing.

Effect implementation reference is **8bitbubsy/pt2-clone**, not OpenMPT or any other tracker. PT-specific quirks are intentional and bug-for-bug: PatternBreak's decimal-encoded param, period clamp 113..856, sine table sign bit, song-end via `(order, row)` revisit set, vibrato waveform 3 = square, ramp-tremolo's vibratoPos half-check, E5y applied before period lookup, EC0 cuts at tick 0 (via setPeriod → checkMoreEffects path), Fxx tempo deferred 1 tick (CIA reload quirk). See the comment block at the top of [replayer.ts](src/core/audio/replayer.ts) for the current implementation list — only 8xy panning is intentionally a no-op (PT 2.3D ignores it).

### Format modules

[src/core/mod/](src/core/mod/) and [src/core/xm/](src/core/xm/) are independent of the replayer. Each holds its own data model, parser/writer, mutations, and clipboard ops.

- PT: [types.ts](src/core/mod/types.ts) defines `ModSong`/`Pattern`/`Note`/`Sample`. `Note.period` is a Paula period (0 = no note); `sample` is 1-indexed (0 = no sample change). [format.ts](src/core/mod/format.ts) holds `PERIOD_TABLE[finetune][noteIndex]` (16×36 — finetune rows, finetune 8..15 stored as -8..-1), `Effect`/`ExtendedEffect` enums, `PAULA_CLOCK_PAL/NTSC`, and the `empty*()` factories. [parser.ts](src/core/mod/parser.ts) / [writer.ts](src/core/mod/writer.ts) handle strict M.K. parse/write — the parser throws on any other signature.
- XM: [src/core/xm/types.ts](src/core/xm/types.ts) defines `XmSong`/`XmPattern`/`XmNote`/`XmInstrument`/`XmSample`. `XmNote.note` is the 1-based MIDI-style note number (1..96 = C-0..B-7, 97 = key-off, 0 = no note). Variable channel count and per-pattern row count. Instruments hold a list of samples plus a 96-note keyMap.
- [src/state/song.ts](src/state/song.ts) exposes `song` (union `ModSong | XmSong | null`) plus narrowed `pt2Song` / `xm2Song` memos for type-specific call sites. The commit path is split too — `commitEdit` / `commitEditWithWorkbenches` for PT, `commitEditXm` / `commitEditXmWithWorkbenches` for XM.

### Accuracy test bed

[tests/render-accuracy.test.ts](tests/render-accuracy.test.ts) renders every `tests/fixtures/*.mod` at the reference WAV's sample rate, then compares channel-for-channel via [tests/lib/compare.ts](tests/lib/compare.ts) (RMS + peak). Bit-exact match against pt2-clone is not the goal — we tolerate `RMS < 0.005` and `peak < 0.05` for floating-point and BLEP edge-case drift.

The "ground truth" tool is [vendor/bin/pt2-render](vendor/headless/), a headless build of pt2-clone with a custom `main.c` and SDL2 shim — no audio device, no GUI. [vendor/build-pt2-clone.sh](vendor/build-pt2-clone.sh) clones pt2-clone fresh on every run (`git reset --hard origin/HEAD`); local edits to `vendor/pt2-clone/` will be lost.

Each fixture targets exactly one behavior (resampler, filter, vibrato waveform, etc.) — see [tests/fixtures/README.md](tests/fixtures/README.md). Don't pile features into one fixture; add a new one.

### State + shared factories

[src/state/song.ts](src/state/song.ts) holds the loaded `Song` as a Solid signal. The `Song` itself is not deeply reactive — every commit replaces the whole signal value.

The PT and XM tracks share factored-out helpers so most of the editing logic lives once:

- [workbenchStore.ts](src/state/workbenchStore.ts) — `createWorkbenchStore<K, V>()` powers both `sampleWorkbench.ts` (PT, slot keyed by number) and `xmSampleWorkbench.ts` (XM, keyed by `${inst}:${sampleIdx}`).
- [sampleSelectionStore.ts](src/state/sampleSelectionStore.ts) — half-open `{start, end}` signal shared by PT and XM waveform selections (XM indexes by frame, not byte).
- [editPrimitives.ts](src/state/editPrimitives.ts) — `createRangedSignal` factory used by [edit.ts](src/state/edit.ts) (octave / sample / editStep) and [xmEdit.ts](src/state/xmEdit.ts) (octave / instrument / sample-index).
- [cursorPrimitives.ts](src/state/cursorPrimitives.ts) — `moveAlongFields` + `cycleChannel`, shared by both cursors' left/right/tab primitives. Row movement stays format-specific (PT walks `flattenSong` for Dxx-aware cross-order traversal; XM walks per-pattern row counts).
- [orderEditCore.ts](src/state/orderEditCore.ts) — `createOrderEdit<S>(adapter)` factory for jump/insert/delete/step ops. Both [orderEdit.ts](src/state/orderEdit.ts) and [xmOrderEdit.ts](src/state/xmOrderEdit.ts) instantiate it. PT's `cleanupOrderList` (patternNames remap) stays format-specific.
- [patternEditCore.ts](src/state/patternEditCore.ts) — `createPatternEdit<S, C, Cell>(adapter)` covers applyCursor / extendSelection / step helpers / selectAllStep / clipboard ops (copy/cut/paste/transpose) / backspace / insertEmpty / clearAtCursor / repeatLastEffect. Format-specific note entry, hex entry, XM-only effect-letter / key-off / row-count / channel-count handlers stay in [patternEdit.ts](src/state/patternEdit.ts) / [xmPatternEdit.ts](src/state/xmPatternEdit.ts).
- [samplePipeline.ts](src/state/samplePipeline.ts) — `makePipelineActions<W>(host)` handles addEffect / removeEffect / moveEffect / patchEffect / setEffectBypass plus the four envelope-point handlers. Format-specific persistence (slot addressing, source-kind toggles, applyChainToSource loop-pin) stays in [sampleEdit.ts](src/state/sampleEdit.ts) / [xmSampleEdit.ts](src/state/xmSampleEdit.ts).
- [keybindHelpers.ts](src/state/keybindHelpers.ts) — `PIANO_KEYS`, `HEX_KEYS`, `DIGIT_QUICK_PICK` tables shared by both registration files. The registration files themselves stay separate (PT defaults; XM gates on `isFt2Mode`).

When extending behavior: most operations belong in the core factories; only format-specific quirks (PT period clamp, XM volume column nibbles, XM extended effect codes G..X, etc.) go in the per-format file.

### Views

The app has four top-level views — `'pattern'`, `'sample'`, `'info'`, `'settings'` — driven by the `view` signal in [src/state/view.ts](src/state/view.ts). They occupy the same `<main>` slot; the layout's `grid-template-columns` flips between 3 columns (samples / main / order) for `pattern`, 2 (samples / main) for `sample`, and main-only for `info` / `settings` via the `.app--view-*` class on the root. The sample list pane is shared across pattern and sample views; `currentSample()` from [src/state/edit.ts](src/state/edit.ts) is what both the pattern grid and the sample editor read. All four panes stay mounted at all times — toggling the view just flips a `view-hidden` class.

Sample editing has its own mutations (`setSample`, `clearSample`, `replaceSampleData` in [src/core/mod/mutations.ts](src/core/mod/mutations.ts)) and an importer ([src/core/mod/sampleImport.ts](src/core/mod/sampleImport.ts)) that converts a parsed WAV into 8-bit signed mono. The WAV reader/writer lives at [src/core/audio/wav.ts](src/core/audio/wav.ts) and is shared between the runtime importer and the offline-render test bed.

### Sample pipeline

The sample editor wraps each loaded WAV in a [SampleWorkbench](src/core/audio/sampleWorkbench.ts) (PT) or [XmSampleWorkbench](src/core/audio/sampleWorkbench.ts) (XM): a source `WavData` plus an editable list of pure `WavData → WavData` effect nodes (gain, normalize, reverse, crop, fade in/out) terminated by a format-specific transformer (PT: mono mix + int8 quantise; XM: mono mix + 8/16-bit quantise). Workbenches are **session-only** (cleared on `.mod` / `.xm` load, never serialised back into those formats). Whenever a workbench changes, the format-specific update path re-runs the pipeline and pushes the resulting sample bytes into the slot. Playback never sees the workbench — it reads the int8 / int16 result like any other sample. Sampler sources (the input WAV bytes) and chiptune params persist via `.retro` so a project round-trips with its full pipeline; the chain itself does too.

Chain + envelope mutations go through the shared `makePipelineActions<W>` factory (see _State + shared factories_ above); only format-specific persistence (source-kind toggles, loop policy, slot addressing) lives in the per-format file.

### Optional backend

The app is a static SPA by default. An optional Node backend at [server/](server/) (Hono) exposes `/api/{projects,samples,modules}` for listing / GET / PUT / DELETE of `.retro` projects, `.wav` samples, and `.mod` / `.xm` modules — names may include slashes for subdirectories; [server/storage.ts](server/storage.ts) rejects `..`, dotfiles, wrong extensions, and resolves paths under the configured root.

Wiring:

- **Dev**: [server/vitePlugin.ts](server/vitePlugin.ts) registers the Hono `fetch` handler as Vite middleware so `npm run dev` runs both on one port. Backend is always on in dev; data lives in `./data/{projects,samples,modules}` (gitignored). Override with `RETROTRACKER_DATA_DIR`.
- **Prod**: [server/index.ts](server/index.ts) is the entry — Node `http` that serves `dist/` (with SPA fallback to `index.html`) and conditionally mounts the API. esbuild bundles it (`npm run build:server`) to `dist-server/index.mjs`. Backend is **off by default** and activates only when `RETROTRACKER_BACKEND=1` is set at runtime, so CI-built images stay inert until an operator opts in. Default data dir is `/`, so volumes mount as `/projects`, `/samples`, `/modules`.
- **Frontend**: [src/state/backend.ts](src/state/backend.ts) pings `/api/health` on boot and flips the `backendAvailable` signal. When set, [App.tsx](src/App.tsx) adds "Open from cloud…" / "Save to cloud…" entries to the File menu (rendered by [ServerBrowser](src/components/ServerBrowser.tsx)). "Open from cloud" lists `.retro` projects and `.mod` / `.xm` modules merged — the user sees one list of songs, not two buckets. Loading routes through `loadServerBytes` → `loadFile` so file-picker, drag-drop, and cloud paths share format sniffing.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess` — array/record access returns `T | undefined`. Use `arr[i]!` only when an invariant guarantees presence (e.g., `PERIOD_TABLE[finetune]!` — finetune is 0..15).
- Path alias `~/*` → `src/*` (configured in [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts)).
- Constants like `CHANNELS = 4`, `ROWS_PER_PATTERN = 64` live in [src/core/mod/types.ts](src/core/mod/types.ts) — import them, don't hardcode.
- When adding effects to the replayer: tick-0 setup goes in `applyTick0Effect`/`applyExtendedTick0`, per-tick continuous behavior in `tickEffect`. Cross-check pt2-clone's source before assuming behavior.
