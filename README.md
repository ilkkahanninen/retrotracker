# RetroTracker

A modern, web-based ProTracker module editor.

- **UI**: Solid.js + Vite + TypeScript. Modern UX with full mouse + keyboard.
- **Output**: Strict 4-channel ProTracker `.mod` (M.K.).
- **Playback reference**: [pt2-clone by 8bitbubsy](https://github.com/8bitbubsy/pt2-clone).
- **Test bed**: offline render that compares against pt2-clone reference WAVs.

## Status

Project scaffold. Implemented:

- MOD parser + writer (M.K., 31-sample, 4-channel)
- WAV PCM reader/writer + buffer comparison utility (RMS, peak, sample-level)
- Replayer / offline renderer **stubs** with the right shapes — produce silence today
- Solid app shell

The replayer is the next major task. Architecture is set up so the same pure mixing routine drives both the live `AudioWorklet` and the offline render used by tests.

## Layout

```
src/
  core/
    mod/         MOD format types, period table, parser, writer
    audio/       Replayer state machine, offline renderer, AudioWorklet
  state/         Solid stores (song, transport, selection)
  ui/            Solid components
tests/
  lib/           WAV I/O, buffer comparison, render CLI
  fixtures/      .mod files + matching pt2-clone reference WAVs
```

## Scripts

```bash
npm install
npm run dev         # Vite dev server
npm run build       # Production build
npm run typecheck
npm run test        # Vitest (offline render vs reference WAV)
npm run render -- input.mod output.wav   # Offline render via CLI
```

## Generating reference WAVs from pt2-clone

The accuracy test compares our offline render against WAVs produced by pt2-clone.
See [`tests/fixtures/README.md`](tests/fixtures/README.md) for the exact command
line and conventions for naming fixtures.

## References

- [ProTracker 2.3D effects reference](https://wiki.openmpt.org/Manual:_Effect_Reference#MOD_effect_commands)
- [pt2-clone source](https://github.com/8bitbubsy/pt2-clone) — authoritative replayer
- Period table: see [`src/core/mod/format.ts`](src/core/mod/format.ts)
