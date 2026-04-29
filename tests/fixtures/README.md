# Test fixtures

Each fixture is a pair:

- `name.mod` — a strict 4-channel ProTracker module
- `name.reference.wav` — pt2-clone's offline render of that module

The accuracy test discovers any pair matching this convention and asserts
that our offline renderer matches the reference within tolerance.

## Generating a reference WAV with pt2-clone

[pt2-clone](https://github.com/8bitbubsy/pt2-clone) supports rendering to
WAV from the command line. Build it from source, then:

```bash
pt2-clone --render-to-wav name.mod name.reference.wav
```

Use a stereo PCM WAV at 44100 Hz (the default) or 48000 Hz. 16-bit and
24-bit are both supported by our reader.

## Conventions

- Keep fixtures small and focused. A 10–30 second song is enough.
- Name them after the behavior they exercise: `tone-portamento.mod`,
  `vibrato-waveform.mod`, `pattern-loop-edge.mod`.
- A `name.mod` without a matching `name.reference.wav` is silently ignored
  — useful for staging modules before you've generated the reference.
- Don't commit unrelated WAVs; `.gitignore` only allows `*.reference.wav`.

## Why pt2-clone

It is the most accurate open-source ProTracker 2.3D replayer and the
authoritative reference for quirks (period clamping, extended effects,
BLEP-resampled output). Comparing against it lets us catch regressions
that the ear would miss.
