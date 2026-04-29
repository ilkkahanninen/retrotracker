# Test fixtures

Each fixture is a `.mod` plus a generated `.reference.wav`:

- `name.mod` — strict 4-channel ProTracker module, synthesized by [generate.ts](generate.ts). Committed.
- `name.reference.wav` — pt2-clone's render of that module. Generated locally on first test run; gitignored.

[tests/render-accuracy.test.ts](../render-accuracy.test.ts) compares
our offline renderer to each reference at the reference WAV's sample rate.
Missing references (and a missing `vendor/bin/pt2-render`) are auto-built.

## Fixtures

`00-baseline` is the sanity anchor — if it diverges, the gap is in the
resampler or period math, not in a specific effect.

| Fixture | Targets | Notes |
| --- | --- | --- |
| `00-baseline` | resampler-only delta | Triangle sample. 4 sustained notes, no effects. |
| `01-resampling` | linear interp vs BLEP | Square wave, 21-note diatonic scale C-1..B-3. |
| `02-amiga-filter` | LED filter (E00/E01) | Square wave, filter toggled 4×. |
| `03-vibrato-waveforms` | E40–E43 select | Held vibrato note, waveform switches every 16 rows. |
| `04-tremolo-waveforms` | E70–E73 select | Same shape as `03`, for tremolo. |
| `05-glissando` | E30/E31 | C-2 → G-2 tone-porta done twice: smooth, then stepping. |
| `06-panning` | 8xy command | PT 2.3D ignores 8xy; pins "we ignore it too". |
| `07-invert-loop` | EFy | Looped sample with EF1/EF8/EFF then EF0. |

## Commands

```bash
npm run fixtures:generate    # regenerate the .mod files (deterministic)
npm run pt2-clone:build      # build vendor/bin/pt2-render (one-time, ~1s)
npm run fixtures:render      # render every .mod to a .reference.wav
```

Direct render:

```bash
vendor/bin/pt2-render in.mod out.wav --rate=44100
```

Output is 16-bit stereo PCM at the requested rate.

## Conventions

- One behavior per fixture. Piling features in defeats the point.
- Default speed (6) and tempo (125) → ~7.7 s per pattern. Stay under 2 patterns.
- `.mod` files are committed. Reference WAVs are not — they're rebuilt on demand.

## Why pt2-clone

Most accurate open-source ProTracker 2.3D replayer. Authoritative on the
quirks (period clamping, extended effects, BLEP resampling) we want to match.
