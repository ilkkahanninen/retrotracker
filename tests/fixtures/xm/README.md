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

- **Vibrato / tremolo on tick 0**: every other tick matches libxmp, but on the first tick of a row FT2 (which we follow) holds the previous tick's pitch or volume while libxmp already shows the next LFO step. That one-tick-in-six difference is the remaining RMS. Things libxmp does differently from FT2 are kept out of the fixtures and pinned by unit tests instead: the E44–E47 / E74–E77 "keep phase across notes" bit (libxmp ignores it), the tremolo ramp shape, and the pitch / volume FT2 leaves in place after the last effect row.
- **Auto-vibrato is not compared.** libxmp plays the instrument auto-vibrato sine inverted relative to FT2 and numbers the other waveforms differently (type 1 as a ramp, 2 as a square, 3 as random; FT2 has 1 = square, 2 and 3 = ramps). The four auto-vibrato fixtures stay in the directory but the bed skips them; [tests/xm-autovibrato.test.ts](../../xm-autovibrato.test.ts) checks the behaviour against ft2-clone's `updateVolPanAutoVib` instead.
- **Anti-click ramp shape**: libxmp and XmReplayer use slightly different ramp lengths for mid-tick volume cuts (ECy, EDy) and pan changes. Transient diff lives in a ~50-sample window around the change.
- **Fadeout / finetune slow drift**: per-tick float / integer rounding differs by a few period units over a multi-row hold.

## Measurements

| Fixture                       | Targets           | RMS     | Peak   | Notes                                                                                                                       |
| ----------------------------- | ----------------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `00-baseline`                 | mixer-only delta  | 0.00002 | 0.0008 | Single sustained C-4.                                                                                                       |
| `01-volume-slide`             | Axy               | 0.00011 | 0.0051 | Square wave under volume slide.                                                                                             |
| `02-arpeggio`                 | 0xy               | 0.00002 | 0.0008 | XM no-memory arpeggio + per-tick offset model.                                                                              |
| `03-retrigger`                | retrigger         | 0.00005 | 0.0008 | Hammered C-4 every 2 rows — exercises the discharge curve.                                                                  |
| `04-period-slide`             | 1xx, 2xx          | 0.00021 | 0.0070 | Linear-mode period slide up / down.                                                                                         |
| `05-fine-slide`               | E1y/E2y, X1y/X2y  | 0.00004 | 0.0015 | Tick-0 fine + extra-fine period bumps.                                                                                      |
| `06-tone-porta`               | 3xx               | 0.00003 | 0.0042 | C-4 → G-4 porta with target on row 4.                                                                                       |
| `07-vibrato`                  | 4xy               | 0.00612 | 0.0172 | Tick-0 hold; rms ≤ 0.01.                                                                                                    |
| `08-tremolo`                  | 7xy               | 0.00714 | 0.0732 | Tick-0 hold; rms ≤ 0.012, peak ≤ 0.1.                                                                                       |
| `09-tone-porta-vol-slide`     | 5xy               | 0.00011 | 0.0059 | Porta-with-memory + per-tick vol slide.                                                                                     |
| `10-vibrato-vol-slide`        | 6xy               | 0.00876 | 0.0172 | Tick-0 hold; rms ≤ 0.012.                                                                                                   |
| `11-set-finetune`             | E5y               | 0.00718 | 0.0156 | Mid-note finetune; small period drift; rms ≤ 0.01.                                                                          |
| `12-set-volume`               | Cxx               | 0.00023 | 0.0130 | Direct volume changes; anti-click peak ≤ 0.02.                                                                              |
| `13-fine-vol-slide`           | EAy, EBy          | 0.00003 | 0.0008 | Single-tick volume bumps.                                                                                                   |
| `14-global-vol`               | Gxx, Hxy          | 0.00013 | 0.0065 | Global volume set + slide.                                                                                                  |
| `15-panning`                  | 8xx, E8y, Pxy     | 0.00005 | 0.0008 | Effect-column pan paths.                                                                                                    |
| `16-sample-offset`            | 9xx               | 0.00002 | 0.0009 | Re-trigger at offsets 0x04, 0x07.                                                                                           |
| `17-note-cut`                 | ECy               | 0.00191 | 0.0855 | EC2 + EC0 cut; ramp shape diff; peak ≤ 0.1.                                                                                 |
| `18-note-delay`               | EDy               | 0.00060 | 0.0340 | ED3 + ED5 deferred trigger; peak ≤ 0.04.                                                                                    |
| `19-set-speed`                | Fxx ≤ 32          | 0.00001 | 0.0008 | Speed (ticks/row) change.                                                                                                   |
| `20-set-tempo`                | Fxx > 32          | 0.00011 | 0.0089 | BPM change mid-song.                                                                                                        |
| `21-multi-channel`            | 4-voice mix       | 0.00004 | 0.0027 | 4 hard-panned notes; needs output clipping to compare.                                                                      |
| `22-key-off`                  | note 97 + Kxx     | 0.00225 | 0.0855 | Voice silence with no envelope; ramp diff; rms ≤ 0.003.                                                                     |
| `23-fadeout`                  | fadeout countdown | 0.02520 | 0.3415 | Linear decay after key-off; rms ≤ 0.04, peak ≤ 0.4.                                                                         |
| `24-volume-envelope`          | vol env + sustain | 0.00035 | 0.0031 | Attack → sustain envelope.                                                                                                  |
| `25-pan-envelope`             | pan env sweep     | 0.00151 | 0.0114 | Full-left to full-right pan ramp; peak ≤ 0.02.                                                                              |
| `26-auto-vibrato`             | instrument vib    | —       | —      | Not compared: libxmp plays XM auto-vibrato differently from FT2 (see Tolerances).                                           |
| `27-set-env-pos`              | Lxx               | 0.00163 | 0.0126 | Jump vol-env to mid-decay; peak ≤ 0.02.                                                                                     |
| `28-relative-note`            | sample.relative   | 0.00001 | 0.0007 | relativeNote = 12 → C-4 plays as C-5.                                                                                       |
| `29-amiga-freq`               | Amiga period      | 0.00002 | 0.0008 | `flags.linearFreq = false`.                                                                                                 |
| `30-ping-pong-loop`           | bidir loop        | 0.00002 | 0.0009 | 64-sample sine with ping-pong reflection.                                                                                   |
| `31-sample-16bit`             | 16-bit data       | 0.00002 | 0.0007 | Native Int16Array sample.                                                                                                   |
| `32-pattern-break`            | Dxx               | 0.00002 | 0.0008 | Forward break to next order at row N.                                                                                       |
| `33-position-jump`            | Bxx               | 0.00002 | 0.0008 | Skip a pattern in the order list.                                                                                           |
| `34-volcol-set-vol`           | volcol 1..5       | 0.00002 | 0.0008 | High-nibble 1..5 set-volume.                                                                                                |
| `35-volcol-vol-slide`         | volcol 6, 7       | 0.00005 | 0.0011 | High-nibble 6 (down) / 7 (up).                                                                                              |
| `36-volcol-fine-vol`          | volcol 8, 9       | 0.00003 | 0.0008 | Tick-0 fine vol slides.                                                                                                     |
| `37-volcol-set-pan`           | volcol C          | 0.01435 | 0.0458 | Vol-col panning; ramp-shape diff; rms ≤ 0.02, peak ≤ 0.05.                                                                  |
| `38-volcol-pan-slide`         | volcol D, E       | 0.00006 | 0.0008 | Vol-col pan slide left / right.                                                                                             |
| `39-volcol-tone-porta`        | volcol F          | 0.00002 | 0.0020 | Vol-col tone portamento.                                                                                                    |
| `40-volcol-vibrato`           | volcol A, B       | 0.00319 | 0.0132 | Speed set on its own row before the note; tick-0 hold; rms ≤ 0.006.                                                         |
| `41-vol-env-loop`             | env loop          | <0.002  | <0.01  | Vol env with `loopEnabled`, no sustain.                                                                                     |
| `42-vol-env-disabled`         | env.enabled=false | <0.002  | <0.01  | Configured vol env with `enabled: false` — flat volume.                                                                     |
| `43-pan-env-sustain`          | pan env sustain   | <0.002  | <0.01  | Pan env holds at sustain point while key is on.                                                                             |
| `44-pan-env-loop`             | pan env loop      | <0.005  | <0.02  | Pan env cycles loopStart..loopEnd forever.                                                                                  |
| `45-autovib-square`           | autovib type 2    | —       | —      | Not compared: libxmp plays XM auto-vibrato differently from FT2 (see Tolerances).                                           |
| `46-autovib-ramp-down`        | autovib type 1    | —       | —      | Not compared: libxmp plays XM auto-vibrato differently from FT2 (see Tolerances).                                           |
| `47-autovib-ramp-up`          | autovib type 3    | —       | —      | Not compared: libxmp plays XM auto-vibrato differently from FT2 (see Tolerances).                                           |
| `48-multi-sample`             | keyMap routing    | <0.002  | <0.01  | Notes split across two samples via the 96-byte keyMap.                                                                      |
| `49-multi-sample-meta`        | per-sample meta   | <0.002  | <0.02  | Each keyMap-selected sample brings its own vol/pan/finetune.                                                                |
| `50-no-loop`                  | loopType "none"   | 0.004   | 0.4    | Voice silences after sample end; anti-click peak ≤ 0.5.                                                                     |
| `51-partial-loop`             | loopEnd<dataLen   | <0.002  | <0.01  | Sample head played once, then [loopStart, loopEnd) forever.                                                                 |
| `52-pattern-loop`             | E6x               | 0.00004 | 0.0008 | E60 on row 2, E62 on row 4: rows 2..4 play three times.                                                                     |
| `53-pattern-loop-carry`       | E6x FT2 bug       | 0.00003 | 0.0008 | Next pattern starts on the loop's start row. Tracker name is "FastTracker v2.00" so libxmp enables its FT2 quirks.          |
| `54-pattern-delay`            | EEx               | 0.00003 | 0.0008 | EE3 holds a row for 3 extra row-lengths; note does not retrigger.                                                           |
| `55-pattern-delay-break`      | EEx + Dxx         | 0.00003 | 0.0008 | Break on a delayed row is taken after the delay.                                                                            |
| `56-pattern-delay-note-delay` | EEx + EDx         | 0.00003 | 0.0008 | Delayed note fires once, not per repeat.                                                                                    |
| `57-tremor`                   | Txy               | 0.00180 | 0.0414 | T21 then T00: 3 ticks on / 2 off, phase carried across rows. Ramp-shape transient; rms ≤ 0.003, peak ≤ 0.1.                 |
| `58-tremor-hold`              | Txy off-state     | 0.00104 | 0.0393 | Row ending in the off half stays silent until Cxx. Same tolerance.                                                          |
| `59-glissando`                | E3x               | 0.00002 | 0.0008 | Semitone-stepped tone porta, then smooth after E30. Avoids halfway ties and unfinished slides, where FT2 and libxmp differ. |
| `60-vibrato-ramp`             | E41 + 4xy         | 0.02208 | 0.0581 | Ramp waveform; tick-0 hold is a bigger step on a ramp; rms ≤ 0.03.                                                          |
| `61-vibrato-square`           | E42 + 4xy         | 0.01998 | 0.0380 | Square waveform; rms ≤ 0.03.                                                                                                |
| `62-tremolo-square`           | E72 + 7xy         | 0.00794 | 0.1646 | Square waveform; rms ≤ 0.012, peak ≤ 0.2.                                                                                   |
