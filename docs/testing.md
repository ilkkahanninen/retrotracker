# Testing & accuracy bed

The test suite has two halves with very different goals:

1. **Replayer accuracy** — compares our offline render against pt2-clone's, bit-by-bit-ish, across a catalog of fixtures that each isolate one effect or quirk. This is the test we'd be most embarrassed to have wrong.
2. **Editor behavior** — vitest unit tests on parser / mutations / clipboard / mixer logic, plus Solid component tests in jsdom that simulate keyboard input.

Both run under `npm test` (vitest).

## Layout

```
tests/
├── render-accuracy.test.ts         ← A1200 fixtures vs pt2-clone
├── render-accuracy-a500.test.ts    ← A500 fixtures vs pt2-clone
├── replayer-startpos.test.ts       ← initialOrder/initialRow + loopPattern
├── speed-tempo-at.test.ts          ← Fxx behavior + position queries
├── paula-mid-playback-swap.test.ts ← model swap mid-playback
├── parser.test.ts                  ← MOD round-trip
├── fixtures.test.ts                ← fixtures load/parse smoke test
├── io.test.ts                      ← export filename derivation
├── wav.test.ts                     ← RIFF reader/writer
├── shapers.test.ts                 ← waveshaping math
├── chiptune.test.ts                ← deterministic synth, persistence
├── bounce.test.ts                  ← bounce-selection length math
├── loop-truncate.test.ts           ← loopStart=0 fix-up
├── sample-import.test.ts           ← WAV→int8 mono
├── sample-selection.test.ts        ← crop/cut sample
├── sample-workbench.test.ts        ← chain + PT transformer (largest unit-test file)
├── mutations.test.ts               ← all setCell/insert/delete/etc.
├── clipboard-ops.test.ts           ← readSlice/clearRange/pasteSlice
├── selection-state.test.ts         ← selection signal
├── edit-state.test.ts              ← currentSample/octave/editStep
├── cursor.test.ts                  ← navigation primitives
├── keyboard-layout.test.ts         ← QWERTY/Dvorak mapping
├── shortcuts.test.ts               ← keybinding installer
├── history.test.ts                 ← undo/redo across edit kinds
├── persistence-chiptune.test.ts    ← .retro chiptune round-trip
├── lib/                            ← helpers
│   ├── compare.ts                  ← RMS/peak channel comparison
│   └── render-cli.ts               ← `npm run render` CLI
├── fixtures/                       ← .mod + .reference.wav per fixture
│   ├── README.md                   ← fixture catalog (see below)
│   ├── generate.ts                 ← deterministic .mod synthesizer
│   └── 00-baseline.mod, …          ← committed fixtures (29 currently)
└── ui/                             ← Solid component tests (jsdom)
    ├── pattern-grid.test.tsx
    ├── sample-view.test.tsx
    ├── pipeline-editor.test.tsx
    └── …
```

`tests/ui/**` runs in jsdom; everything else runs on Node. The split is configured in [vitest.config.ts](../vitest.config.ts) via `environmentMatchGlobs`. UI test files use `.test.tsx`; non-UI tests use `.test.ts`.

## Running

```bash
npm test                                       # everything
npx vitest run tests/render-accuracy.test.ts   # one file
npx vitest run -t "00-baseline"                # filter by test name
npm run test:watch                             # watch mode
```

UI tests use `@solidjs/testing-library` to mount components and `@testing-library/user-event` to simulate input. Module-level signals (`cursor`, `song`, `transport`, …) persist across tests in the same file, so suites reset them in `beforeEach`.

## Accuracy bed

[tests/render-accuracy.test.ts](../tests/render-accuracy.test.ts) and [tests/render-accuracy-a500.test.ts](../tests/render-accuracy-a500.test.ts) iterate every `tests/fixtures/*.mod` and:

1. Parse the .mod via [parseModule](../src/core/mod/parser.ts).
2. Render through our offline path (`renderToBuffer` → Replayer + Paula + Mixer) at the reference WAV's sample rate.
3. Compare channel-for-channel with [compareChannels](../tests/lib/compare.ts) — per-channel RMS and peak diff.
4. Fail if `RMS >= 0.005` or `peak >= 0.05`.

Tolerances are deliberately loose. Bit-exact match against pt2-clone is unrealistic — different floating-point order, slightly different downsampler edge handling, dither (theirs vs ours). What we DO catch:

- **Effect regressions.** Anything that mishandles vibrato/tremolo waveform select, glissando, fine slides, retrigger, etc. lights up immediately on the relevant fixture.
- **Period math drift.** `00-baseline` is a sustained-note sanity anchor — if it diverges, the gap is in the resampler or period table, not in any specific effect.
- **Filter regressions.** `02-amiga-filter` fires on the LED filter, and `*-A500.wav` references on the A500-only LP filter.
- **Tempo/timing drift.** `18-set-speed` exercises Fxx and the CIA quirk; tempo regressions show up as a steady RMS climb across the fixture.

### Reference WAVs

- A1200 references: `name.reference.wav` — pt2-clone's render at the same Paula model RetroTracker defaults to.
- A500 references: `name.reference.A500.wav` — same module rendered with A500 filters, used by the A500 accuracy test.

WAVs are **gitignored** — every dev rebuilds them locally on first test run. That's possible because pt2-clone is deterministic and the build is fast.

`beforeAll` in the accuracy tests calls `ensureRenderBinary()` (builds `vendor/bin/pt2-render` if missing) and `ensureReferenceWav(fx)` (renders a missing `.reference.wav` via the binary). So a clean `npm test` works without any fixture-rendering ceremony.

### `vendor/bin/pt2-render` — the ground truth

`vendor/build-pt2-clone.sh` does:

1. Fresh-clone `8bitbubsy/pt2-clone` into `vendor/pt2-clone/` (or `git fetch && reset --hard` if it already exists). Local edits to that tree are wiped on every build — don't put workarounds there.
2. Compile a small bundle of pt2-clone sources against our own [`vendor/headless/main.c`](../vendor/headless) and a tiny SDL2 shim. No audio device, no GUI, no real SDL2 dependency.
3. Output `vendor/bin/pt2-render`.

Direct usage:

```bash
vendor/bin/pt2-render in.mod out.wav --rate=44100              # A1200 (default)
vendor/bin/pt2-render in.mod out.wav --rate=44100 --model=A500
```

Output is 16-bit stereo PCM at the requested rate. Build is one-time, ~1s. Auto-built by the test bed when missing.

### Fixture catalog

Each fixture targets exactly one behavior. The full table lives in [tests/fixtures/README.md](../tests/fixtures/README.md). Highlights:

| Fixture                    | What it pins                          |
| -------------------------- | ------------------------------------- |
| `00-baseline`              | Resampler + period math sanity        |
| `01-resampling`            | BLEP across a chromatic scale         |
| `02-amiga-filter`          | E00/E01 LED filter toggle             |
| `03-vibrato-waveforms`     | E40..E43 select + PT3=square quirk    |
| `04-tremolo-waveforms`     | E70..E73 select + PT vibratoPos quirk |
| `05-glissando`             | E30/E31 with tone porta               |
| `06-panning`               | 8xy is intentionally a no-op          |
| `07-invert-loop`           | EFy destructive byte invert           |
| `08-arpeggio` … `28-pattern-delay` | One per effect, A→F + extended Exy |

Adding a fixture: write a deterministic `.mod` synth in [tests/fixtures/generate.ts](../tests/fixtures/generate.ts), regenerate via `npm run fixtures:generate`, render the reference via `npm run fixtures:render`, commit the `.mod` (not the WAV).

**One behavior per fixture.** Piling features in defeats the point — when a regression hits, you want a fixture name that pinpoints which path broke.

### Why not exact match?

Our resampler differs from pt2-clone's in a few places:

- Different floating-point order in the polyphase FIR.
- Slight differences in BLEP impulse insertion timing (we batch BLEP additions per mix-chunk; pt2-clone inserts them inside the per-voice loop).
- Dither (or lack thereof) on int8 → float conversion.

These produce a steady ~10⁻⁴ RMS noise floor that's audibly inaudible but bit-distinct. The tolerance bands are tight enough to catch real regressions and loose enough to ignore the noise floor.

## Editor unit tests

The non-accuracy node tests are conventional vitest suites — pure-function checks on:

- **Parser/writer round-trip** ([parser.test.ts](../tests/parser.test.ts), [io.test.ts](../tests/io.test.ts), [wav.test.ts](../tests/wav.test.ts)).
- **Mutations** ([mutations.test.ts](../tests/mutations.test.ts)) — every export from [mod/mutations.ts](../src/core/mod/mutations.ts) has cases for the happy path, the no-op short-circuit, and out-of-range inputs.
- **Clipboard ops** ([clipboard-ops.test.ts](../tests/clipboard-ops.test.ts)) — read/clear/paste, including paste clipping at pattern bounds.
- **Sample workbench** ([sample-workbench.test.ts](../tests/sample-workbench.test.ts)) — every effect node, the chain runner, the resampler modes, and the PT transformer. The biggest single test file, by design — the pipeline has the most surface area.
- **Chiptune determinism** ([chiptune.test.ts](../tests/chiptune.test.ts)) — same params in → same int8 out, plus the snap functions for power-of-two ratios.
- **Persistence** ([persistence-chiptune.test.ts](../tests/persistence-chiptune.test.ts)) — chiptune source round-trip through `.retro`.
- **History** ([history.test.ts](../tests/history.test.ts)) — undo/redo across the three snapshot kinds (song, workbenches, pattern names).
- **Replayer state** ([replayer-startpos.test.ts](../tests/replayer-startpos.test.ts), [speed-tempo-at.test.ts](../tests/speed-tempo-at.test.ts), [paula-mid-playback-swap.test.ts](../tests/paula-mid-playback-swap.test.ts)) — start position, position queries, model swaps mid-playback.
- **Bounce** ([bounce.test.ts](../tests/bounce.test.ts)) — the silence-cropping math behind bounce-selection.
- **Loop truncate** ([loop-truncate.test.ts](../tests/loop-truncate.test.ts)) — the `loopStart=0` fix-up.

## UI tests (jsdom)

[tests/ui/](../tests/ui/) — Solid component mounts with `@solidjs/testing-library` + simulated input via `@testing-library/user-event`. Each suite covers one UI surface:

| File                                                                      | Surface                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [app-keyboard.test.tsx](../tests/ui/app-keyboard.test.tsx)                | Note entry, edit step, octave switch, transport keys          |
| [pattern-grid.test.tsx](../tests/ui/pattern-grid.test.tsx)                | Cursor navigation, selection extension, channel mute/solo     |
| [pattern-help.test.tsx](../tests/ui/pattern-help.test.tsx)                | Effect hint rendering                                         |
| [sample-view.test.tsx](../tests/ui/sample-view.test.tsx)                  | Sample editor mount + source toggle                           |
| [sample-loop-edit.test.tsx](../tests/ui/sample-loop-edit.test.tsx)        | Loop-bound interactions                                       |
| [sample-preview.test.tsx](../tests/ui/sample-preview.test.tsx)            | Audition keypress → preview state                              |
| [sample-select.test.tsx](../tests/ui/sample-select.test.tsx)              | Range selection in waveform                                   |
| [pipeline-editor.test.tsx](../tests/ui/pipeline-editor.test.tsx)          | Effect add / remove / param edit                              |
| [preview-tracker.test.tsx](../tests/ui/preview-tracker.test.tsx)          | Animated playhead during preview                              |
| [transpose.test.tsx](../tests/ui/transpose.test.tsx)                      | Range transpose ±1, ±12, with bounds clamping                 |
| [order-edit.test.tsx](../tests/ui/order-edit.test.tsx)                    | Order list mutations + cursor sync                            |
| [effect-entry.test.tsx](../tests/ui/effect-entry.test.tsx)                | Per-field hex entry semantics                                 |
| [clipboard-shortcuts.test.tsx](../tests/ui/clipboard-shortcuts.test.tsx)  | Copy / cut / paste shortcuts                                  |
| [drag-drop.test.tsx](../tests/ui/drag-drop.test.tsx)                      | Drop .mod / .retro / .wav onto the page                       |
| [export-mod.test.tsx](../tests/ui/export-mod.test.tsx)                    | Save .mod payload + filename derivation                       |
| [file-menu.test.tsx](../tests/ui/file-menu.test.tsx)                      | New / Open / Save / Save As menu wiring                       |
| [info-view.test.tsx](../tests/ui/info-view.test.tsx)                      | Info text editor binding                                      |
| [persistence.test.tsx](../tests/ui/persistence.test.tsx)                  | localStorage round-trip on a real component tree              |

These tests don't touch the audio engine — `ensureEngine()` returns null in jsdom (no `AudioContext`). The UI is verified to stay coherent in that mode (no crashes, transport stays `idle`, audition is a silent no-op).

## Render CLI

`npm run render -- in.mod out.wav [--seconds=N] [--rate=44100]` is the same offline path the test bed uses, exposed via [tests/lib/render-cli.ts](../tests/lib/render-cli.ts). Useful for spot-checking by ear:

```bash
npm run render -- some-song.mod out.wav --seconds=30
ffplay out.wav    # or whatever your player is
```

## What's not tested

- **Live worklet path.** `AudioWorklet` doesn't run in jsdom or Node, so worklet behavior is verified indirectly: the Replayer the worklet hosts is the same one the offline tests pound on.
- **Real `AudioContext` latency / glitch behavior.** Out of scope for unit tests; verified manually in `npm run dev`.
- **Cross-browser visual rendering.** No screenshot test bed yet.

When changing replayer behavior: add or pick a fixture, run `npx vitest run tests/render-accuracy.test.ts`, check the per-channel diff metrics. When changing UI: add a jsdom test to [tests/ui/](../tests/ui/).
