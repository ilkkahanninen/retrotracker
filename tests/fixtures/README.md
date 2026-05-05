# Test fixtures

Each fixture is a `.mod` plus a generated `.reference.wav` per Amiga model:

- `name.mod` — strict 4-channel ProTracker module, synthesized by [generate.ts](generate.ts). Committed.
- `name.reference.wav` — pt2-clone's A1200 render of that module. Generated locally on first test run; gitignored.
- `name.reference.A500.wav` — pt2-clone's A500 render of the same module (extra ~4.4 kHz LP filter). Same generated-on-demand convention.

[tests/render-accuracy.test.ts](../render-accuracy.test.ts) compares our
offline renderer to each A1200 reference; [tests/render-accuracy-a500.test.ts](../render-accuracy-a500.test.ts)
does the same against the A500 references with `amigaModel: 'A500'`. Missing
references (and a missing `vendor/bin/pt2-render`) are auto-built.

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
| `08-arpeggio` | 0xy | Sustained note, major / minor / octave / fifth arpeggios. |
| `09-slide-up` | 1xx | Sustained note with periodic slide-up at varying speeds. |
| `10-slide-down` | 2xx | Sustained note with periodic slide-down at varying speeds. |
| `11-tone-porta-vol-slide` | 5xy | 3xx target, then 5xy continues porta with vol slide. |
| `12-vibrato-vol-slide` | 6xy | 4xy vibrato, then 6xy continues vibrato with vol slide. |
| `13-sample-offset` | 9xx | 1024-byte triangle, retriggered at offsets 0/256/512/768. |
| `14-volume-slide` | Axx | Sustained note with up/down slides at varying speeds. |
| `15-position-jump` | Bxx | Two patterns; B01 jumps forward, B00 loops back. |
| `16-set-volume` | Cxx | Sustained note with various Cxx sets, including 0 / >64. |
| `17-pattern-break` | Dxx | D10 mid-pattern; orders=[0,0] tests the row jump target. |
| `18-set-speed` | Fxx | Speed (F03/F06) and tempo (F40/F7D) changes. |
| `19-fine-slide-up` | E1y | Sustained note with E11/E12/E14/E18/E1F. |
| `20-fine-slide-down` | E2y | Sustained note with E21/E22/E24/E28/E2F. |
| `21-set-finetune` | E5y | C-2 retriggered at every E5y value 0..F. |
| `22-pattern-loop` | E6y | E60 mark + E62 loops back twice (segment plays 3×). |
| `23-retrigger` | E9y | Sustained note with E91/E92/E94/E96 retrigger intervals. |
| `24-fine-vol-up` | EAy | Volume started low (Cxx), bumped up by EA2/EA4/EA8/EAF. |
| `25-fine-vol-down` | EBy | Sustained note slowly faded by EB2/EB4/EB8/EBF. |
| `26-note-cut` | ECy | Same note triggered with various cut tick offsets. |
| `27-note-delay` | EDy | Different notes with various delay tick offsets. |
| `28-pattern-delay` | EEy | Notes with EE1/EE2/EE3/EE5 row repeats. |

## Commands

```bash
npm run fixtures:generate    # regenerate the .mod files (deterministic)
npm run pt2-clone:build      # build vendor/bin/pt2-render (one-time, ~1s)
npm run fixtures:render      # render every .mod to a .reference.wav
```

Direct render:

```bash
vendor/bin/pt2-render in.mod out.wav --rate=44100             # A1200 (default)
vendor/bin/pt2-render in.mod out.wav --rate=44100 --model=A500
```

Output is 16-bit stereo PCM at the requested rate.

## Conventions

- One behavior per fixture. Piling features in defeats the point.
- Default speed (6) and tempo (125) → ~7.7 s per pattern. Stay under 2 patterns.
- `.mod` files are committed. Reference WAVs are not — they're rebuilt on demand.

## Why pt2-clone

Most accurate open-source ProTracker 2.3D replayer. Authoritative on the
quirks (period clamping, extended effects, BLEP resampling) we want to match.
