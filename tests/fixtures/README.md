# Test fixtures

Each fixture is a pair:

- `name.mod` — a strict 4-channel ProTracker module (synthesized by [generate.ts](generate.ts))
- `name.reference.wav` — pt2-clone's offline render of that module

The accuracy test in [tests/render-accuracy.test.ts](../render-accuracy.test.ts)
auto-discovers any `.mod` with a matching `.reference.wav` and asserts that
our offline renderer matches the reference within tolerance.

## The fixture set

Each fixture targets a single behavior. The first row, `00-baseline`, is a
sanity anchor — if it doesn't match, the gap is in the resampler/period
math and not in any specific effect.

| Fixture | Targets | What it does |
| --- | --- | --- |
| `00-baseline` | resampler baseline | Triangle sample, 4 sustained notes (C-2/E-2/G-2/C-3), no effects. The smallest delta possible. |
| `01-resampling` | linear interp vs BLEP | Square wave (rich in harmonics) played as a 21-note diatonic scale C-1..B-3. Each pitch gives a different output-sample step ratio, exposing aliasing. |
| `02-amiga-filter` | LED filter (E00/E01) | Sustained square-wave note with E01/E00 toggled four times. Should soften and re-brighten audibly. |
| `03-vibrato-waveforms` | E40–E43 select | Sustained vibrato note that switches waveform (sine → ramp → square → random) every 16 rows. |
| `04-tremolo-waveforms` | E70–E73 select | Same shape as 03, but for tremolo. |
| `05-glissando` | E30/E31 + tone porta | Same C-2 → G-2 tone-portamento done twice: once smooth (E30), once stepping in semitones (E31). |
| `06-panning` | 8xy command | 8xx pans applied to all four channels at varying values. PT 2.3D ignores 8xy; this anchors the "we ignore it too" property. |
| `07-invert-loop` | EFy | Looped triangle sample with EF1, EF8, EFF, then EF0 to disable. Audible only if the player flips loop bytes. |

## Regenerating

```bash
npm run fixtures:generate
```

The generator is deterministic — the same source produces byte-identical
`.mod` files. Commit changes to fixtures only when you intentionally
update the test surface.

## Generating reference WAVs from pt2-clone

Build [pt2-clone](https://github.com/8bitbubsy/pt2-clone) from source.
For each fixture, render to a stereo PCM WAV at the desired sample rate
and save it next to the `.mod`:

```bash
pt2-clone --render-to-wav tests/fixtures/00-baseline.mod \
                          tests/fixtures/00-baseline.reference.wav
```

A loop over all fixtures:

```bash
for mod in tests/fixtures/*.mod; do
  wav="${mod%.mod}.reference.wav"
  pt2-clone --render-to-wav "$mod" "$wav"
done
```

Use 44100 Hz or 48000 Hz, mono or stereo, 16-bit or 24-bit PCM. The
reader in [tests/lib/wav.ts](../lib/wav.ts) handles any combination.
The accuracy test renders our output at the **reference WAV's** sample
rate so the two are directly comparable.

## Conventions

- One behavior per fixture. Don't pile features into one module — the
  whole point is to isolate regressions.
- Default speed (6) and tempo (125), so each fixture is roughly 7.7 s
  per pattern. Keep songs to 1–2 patterns.
- A `name.mod` without a matching `name.reference.wav` is silently
  skipped by the test runner — useful while staging.
- `.gitignore` only allows `*.reference.wav` through; ad-hoc renders
  stay local.

## Why pt2-clone

It is the most accurate open-source ProTracker 2.3D replayer and the
authoritative reference for quirks (period clamping, extended effects,
BLEP-resampled output). Comparing against it lets us catch regressions
that the ear would miss.
