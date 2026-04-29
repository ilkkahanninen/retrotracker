# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RetroTracker is a web-based ProTracker `.mod` editor (Solid + Vite + TypeScript). Strict scope: 4-channel "M.K." modules only (no xCHN/FLT4/etc.). The replayer is the centerpiece; UI is currently a load/play shell.

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

### MOD format module

[src/core/mod/](src/core/mod/) is independent of the replayer.

- [types.ts](src/core/mod/types.ts): `Song`/`Pattern`/`Note`/`Sample` data model. `Note.period` is a Paula period (0 = no note); `sample` is 1-indexed (0 = no sample change).
- [format.ts](src/core/mod/format.ts): `PERIOD_TABLE[finetune][noteIndex]` (16×36 — finetune rows, finetune 8..15 stored as -8..-1), `Effect`/`ExtendedEffect` enums, `PAULA_CLOCK_PAL/NTSC`, `emptySong()`/`emptyPattern()`/`emptyNote()`/`emptySample()` factories.
- [parser.ts](src/core/mod/parser.ts) / [writer.ts](src/core/mod/writer.ts): strict M.K. parse/write. Parser throws on any other signature.

### Accuracy test bed

[tests/render-accuracy.test.ts](tests/render-accuracy.test.ts) renders every `tests/fixtures/*.mod` at the reference WAV's sample rate, then compares channel-for-channel via [tests/lib/compare.ts](tests/lib/compare.ts) (RMS + peak). Bit-exact match against pt2-clone is not the goal — we tolerate `RMS < 0.005` and `peak < 0.05` for floating-point and BLEP edge-case drift.

The "ground truth" tool is [vendor/bin/pt2-render](vendor/headless/), a headless build of pt2-clone with a custom `main.c` and SDL2 shim — no audio device, no GUI. [vendor/build-pt2-clone.sh](vendor/build-pt2-clone.sh) clones pt2-clone fresh on every run (`git reset --hard origin/HEAD`); local edits to `vendor/pt2-clone/` will be lost.

Each fixture targets exactly one behavior (resampler, filter, vibrato waveform, etc.) — see [tests/fixtures/README.md](tests/fixtures/README.md). Don't pile features into one fixture; add a new one.

### State

[src/state/song.ts](src/state/song.ts) holds the loaded `Song` as a Solid signal. The `Song` itself is not deeply reactive — pattern editing will get its own store when that work starts.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess` — array/record access returns `T | undefined`. Use `arr[i]!` only when an invariant guarantees presence (e.g., `PERIOD_TABLE[finetune]!` — finetune is 0..15).
- Path alias `~/*` → `src/*` (configured in [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts)).
- Constants like `CHANNELS = 4`, `ROWS_PER_PATTERN = 64` live in [src/core/mod/types.ts](src/core/mod/types.ts) — import them, don't hardcode.
- When adding effects to the replayer: tick-0 setup goes in `applyTick0Effect`/`applyExtendedTick0`, per-tick continuous behavior in `tickEffect`. Cross-check pt2-clone's source before assuming behavior.
