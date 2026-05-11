# XM test fixtures

Each fixture is an `.xm` plus a generated `.reference.wav`:

- `name.xm` — minimal FT2 module synthesized by [generate.ts](generate.ts). Committed.
- `name.reference.wav` — libxmp's render of that module via the system `xmp` CLI. Generated locally on first test run; gitignored.

[tests/xm-render-accuracy.test.ts](../../xm-render-accuracy.test.ts) compares our `XmReplayer` output sample-by-sample against the reference, with the first 4 samples skipped to absorb sub-LSB anti-click ramp differences.

## Pre-flight

The bed shells out to `xmp` (libxmp's CLI). Install it once:

- macOS: `brew install libxmp`
- Ubuntu/Debian: `apt-get install xmp` (or `xmp-cli` depending on the distro version)

If `xmp` is not on `PATH`, the entire bed is skipped.

`xmp` is invoked with:

- `-i linear` — match our linear interpolation (xmp's default is cubic spline).
- `-a 2` — match our gain. libxmp's default amplification is `1` (i.e. 0.5× the natural amplitude, leaving headroom for multi-voice mixes); `-a 2` brings the WAV peak in line with our floating-point output.

## Regenerating fixtures

```
npm run fixtures:generate-xm
```

The script produces deterministic `.xm` bytes from `generate.ts`. Commit any changes; subsequent test runs re-use the committed fixtures and re-render the references on demand.

## Tolerances

Default: RMS ≤ 0.002, peak ≤ 0.01 — bit-perfect against libxmp modulo float quantisation noise. A handful of fixtures get per-fixture overrides in `xm-render-accuracy.test.ts`:

- **LFO phase drift** (vibrato / tremolo / auto-vibrato): our 32-entry quarter sine + `>>5` produces the same audible swing as libxmp's 64-entry full sine + `>>9`, but small quantisation differences accumulate over multi-second holds.
- **Anti-click ramp shape**: libxmp and XmReplayer use slightly different ramp lengths for mid-tick volume cuts (ECy, EDy) and pan changes. Transient diff lives in a ~50-sample window around the change.
- **Fadeout / finetune slow drift**: per-tick float / integer rounding differs by a few period units over a multi-row hold.

## Measurements

| Fixture                   | Targets           | RMS     | Peak   | Notes                                                      |
| ------------------------- | ----------------- | ------- | ------ | ---------------------------------------------------------- |
| `00-baseline`             | mixer-only delta  | 0.00002 | 0.0008 | Single sustained C-4.                                      |
| `01-volume-slide`         | Axy               | 0.00011 | 0.0051 | Square wave under volume slide.                            |
| `02-arpeggio`             | 0xy               | 0.00002 | 0.0008 | XM no-memory arpeggio + per-tick offset model.             |
| `03-retrigger`            | retrigger         | 0.00005 | 0.0008 | Hammered C-4 every 2 rows — exercises the discharge curve. |
| `04-period-slide`         | 1xx, 2xx          | 0.00021 | 0.0070 | Linear-mode period slide up / down.                        |
| `05-fine-slide`           | E1y/E2y, X1y/X2y  | 0.00004 | 0.0015 | Tick-0 fine + extra-fine period bumps.                     |
| `06-tone-porta`           | 3xx               | 0.00003 | 0.0042 | C-4 → G-4 porta with target on row 4.                      |
| `07-vibrato`              | 4xy               | 0.05180 | 0.1290 | LFO phase drift; rms ≤ 0.06.                               |
| `08-tremolo`              | 7xy               | 0.03033 | 0.1770 | LFO phase drift; rms ≤ 0.04.                               |
| `09-tone-porta-vol-slide` | 5xy               | 0.00011 | 0.0059 | Porta-with-memory + per-tick vol slide.                    |
| `10-vibrato-vol-slide`    | 6xy               | 0.04647 | 0.1290 | LFO phase drift; rms ≤ 0.05.                               |
| `11-set-finetune`         | E5y               | 0.00718 | 0.0156 | Mid-note finetune; small period drift; rms ≤ 0.01.         |
| `12-set-volume`           | Cxx               | 0.00023 | 0.0130 | Direct volume changes; anti-click peak ≤ 0.02.             |
| `13-fine-vol-slide`       | EAy, EBy          | 0.00003 | 0.0008 | Single-tick volume bumps.                                  |
| `14-global-vol`           | Gxx, Hxy          | 0.00013 | 0.0065 | Global volume set + slide.                                 |
| `15-panning`              | 8xx, E8y, Pxy     | 0.00005 | 0.0008 | Effect-column pan paths.                                   |
| `16-sample-offset`        | 9xx               | 0.00002 | 0.0009 | Re-trigger at offsets 0x04, 0x07.                          |
| `17-note-cut`             | ECy               | 0.00191 | 0.0855 | EC2 + EC0 cut; ramp shape diff; peak ≤ 0.1.                |
| `18-note-delay`           | EDy               | 0.00060 | 0.0340 | ED3 + ED5 deferred trigger; peak ≤ 0.04.                   |
| `19-set-speed`            | Fxx ≤ 32          | 0.00001 | 0.0008 | Speed (ticks/row) change.                                  |
| `20-set-tempo`            | Fxx > 32          | 0.00011 | 0.0089 | BPM change mid-song.                                       |
| `21-multi-channel`        | 4-voice mix       | 0.00004 | 0.0027 | 4 hard-panned notes; needs output clipping to compare.     |
| `22-key-off`              | note 97 + Kxx     | 0.00225 | 0.0855 | Voice silence with no envelope; ramp diff; rms ≤ 0.003.    |
| `23-fadeout`              | fadeout countdown | 0.02520 | 0.3415 | Linear decay after key-off; rms ≤ 0.04, peak ≤ 0.4.        |
| `24-volume-envelope`      | vol env + sustain | 0.00035 | 0.0031 | Attack → sustain envelope.                                 |
| `25-pan-envelope`         | pan env sweep     | 0.00151 | 0.0114 | Full-left to full-right pan ramp; peak ≤ 0.02.             |
| `26-auto-vibrato`         | instrument vib    | 0.01885 | 0.0347 | Sine + sweep; LFO drift; rms ≤ 0.02.                       |
| `27-set-env-pos`          | Lxx               | 0.00163 | 0.0126 | Jump vol-env to mid-decay; peak ≤ 0.02.                    |
| `28-relative-note`        | sample.relative   | 0.00001 | 0.0007 | relativeNote = 12 → C-4 plays as C-5.                      |
| `29-amiga-freq`           | Amiga period      | 0.00002 | 0.0008 | `flags.linearFreq = false`.                                |
| `30-ping-pong-loop`       | bidir loop        | 0.00002 | 0.0009 | 64-sample sine with ping-pong reflection.                  |
| `31-sample-16bit`         | 16-bit data       | 0.00002 | 0.0007 | Native Int16Array sample.                                  |
| `32-pattern-break`        | Dxx               | 0.00002 | 0.0008 | Forward break to next order at row N.                      |
| `33-position-jump`        | Bxx               | 0.00002 | 0.0008 | Skip a pattern in the order list.                          |
| `34-volcol-set-vol`       | volcol 1..5       | 0.00002 | 0.0008 | High-nibble 1..5 set-volume.                               |
| `35-volcol-vol-slide`     | volcol 6, 7       | 0.00005 | 0.0011 | High-nibble 6 (down) / 7 (up).                             |
| `36-volcol-fine-vol`      | volcol 8, 9       | 0.00003 | 0.0008 | Tick-0 fine vol slides.                                    |
| `37-volcol-set-pan`       | volcol C          | 0.01435 | 0.0458 | Vol-col panning; ramp-shape diff; rms ≤ 0.02, peak ≤ 0.05. |
| `38-volcol-pan-slide`     | volcol D, E       | 0.00006 | 0.0008 | Vol-col pan slide left / right.                            |
| `39-volcol-tone-porta`    | volcol F          | 0.00002 | 0.0020 | Vol-col tone portamento.                                   |
| `40-volcol-vibrato`       | volcol A, B       | 0.04449 | 0.0593 | LFO phase drift; rms ≤ 0.05.                               |
