# RetroTracker

A modern, web-based ProTracker module editor.

- **UI**: Solid.js + Vite + TypeScript. Modern UX with full mouse + keyboard.
- **Output**: Strict 4-channel ProTracker `.mod` (M.K.).
- **Playback reference**: [pt2-clone by 8bitbubsy](https://github.com/8bitbubsy/pt2-clone).
- **Test bed**: offline render that compares against pt2-clone reference WAVs.

## Status

Working editor with playback. Plays and edits real `.mod` files; round-trips them through the parser, writer, and replayer.

**Replayer**

- Bug-for-bug match against pt2-clone for all standard effects (`0xx–Fxx`) and the supported extended (`Exy`) family — see the comment block at the top of [src/core/audio/replayer.ts](src/core/audio/replayer.ts) for the full list.
- BLEP synthesis, RC + LED Amiga filters, 2× FIR downsampler ([src/core/audio/paula.ts](src/core/audio/paula.ts)).
- CIA-timer-based tick scheduling with fractional-sample accumulation.
- Same pure state machine drives both the live AudioWorklet and the offline render used by the test bed.
- The only intentionally-skipped effect is `8xy` panning (PT 2.3D ignores it).

**Editor**

- Pattern grid: hex-field cursor (`note → sampleHi → sampleLo → effectCmd → effectHi → effectLo`), live playback highlight, auto-scroll, beat / bar shading.
- Note entry from a piano-row keyboard mapping (Z/X for octave); hex entry on sample / effect nibbles with auto-advance.
- Sample list shared across views — click or 1-0 / Shift+1-0 / -/= to select.
- Sample editor (F3): waveform canvas, name / volume / finetune / loop fields, WAV loader (8/16/24-bit int + float32, mono or stereo, mixed and quantised to PT's 8-bit signed mono).
- Order list: click-to-jump, prev/next pattern (auto-grow), insert / delete / new / duplicate slot — keyboard and toolbar buttons.
- Open `.mod` (drop or ⌘O), save `.mod` (⌘S), undo / redo with a 200-step history.
- Multi-step transport (`Space` / `Shift+Space` / `Alt+Space` / `Alt+Shift+Space`) for play-from-start / play-from-cursor / loop-pattern.

**Tests**

- 266 passing across 20 files: replayer accuracy against pt2-clone reference WAVs (29 fixtures), pattern / sample / order mutations, WAV I/O, sample importer, history, cursor / shortcut routing, and Solid component tests via jsdom + `@testing-library`.
- See [tests/fixtures/README.md](tests/fixtures/README.md) for the accuracy fixture conventions.

**Known gaps**

- No sample export (.mod export bundles them; no standalone WAV save yet).
- No IFF/8SVX importer — only WAV.
- Pattern-block ops (copy / cut / paste across rows / channels) aren't wired.
- Sample editing is metadata + import only — no waveform editing (crop / fade / normalize).
- Touch / mobile UI not addressed.

## Keyboard shortcuts

`⌘` is the platform mod key — Cmd on macOS, Ctrl on Windows/Linux. Bindings are case-insensitive. Editing actions are suppressed while playback is active.

### Transport

| Shortcut | Action |
| --- | --- |
| Space | Play song from start / Stop |
| Shift+Space | Play song from cursor |
| Alt+Space | Play current pattern in a loop, from its first row |
| Alt+Shift+Space | Play current pattern in a loop, from the cursor row |

### File / history

| Shortcut | Action |
| --- | --- |
| ⌘O | Open `.mod` file |
| ⌘S | Save the current song as a `.mod` (downloads the file) |
| ⌘Z | Undo |
| ⌘⇧Z, ⌘Y | Redo |

### Views

| Shortcut | Action |
| --- | --- |
| F2 | Pattern view — order list + pattern grid |
| F3 | Sample view — waveform + sample metadata + WAV loader |

The sample list pane is shared across both views. Whichever sample is selected there is the one the pattern grid stamps on note entry and the one the sample editor edits.

### Cursor navigation

| Shortcut | Action |
| --- | --- |
| ← / → | Previous / next sub-field (`note → sampleHi → sampleLo → effectCmd → effectHi → effectLo`, wraps across channels) |
| ↑ / ↓ | Previous / next row |
| Tab / Shift+Tab | Next / previous channel (jumps cursor back to its note field) |
| PageUp / PageDown | Move by one bar (rows-per-beat × beats-per-bar) |

### Note entry (cursor on the note field)

Two rows of the QWERTY layout act as a piano keyboard. The home row gives naturals, the row above gives sharps:

| Key | Note | Key | Note |
| --- | --- | --- | --- |
| A | C  | W | C# |
| S | D  | E | D# |
| D | E  |   |    |
| F | F  | T | F# |
| G | G  | Y | G# |
| H | A  | U | A# |
| J | B  |   |    |
| K | C+1| O | C#+1 |
| L | D+1| P | D#+1 |
| ; | E+1|   |    |

| Shortcut | Action |
| --- | --- |
| Z / X | Octave down / up |
| `.` | Clear note (also wipes the sample number) |

### Hex entry (cursor on a sample or effect nibble)

| Shortcut | Action |
| --- | --- |
| 0–9, A–F | Type one hex digit. Auto-advance: `sampleHi → sampleLo → row+1` for sample, `effectCmd → effectHi → effectLo → row+1` for effect |
| `.` | Clear the nibble under the cursor (preserves the other nibble; clearing `effectCmd` wipes the param too) |

### Sample selection

| Shortcut | Action |
| --- | --- |
| 1–9, 0 | Select sample 1–10 (only when cursor is on a non-hex field — on hex fields these keys type hex digits) |
| Shift+1–9, 0 | Select sample 11–20 (works on any field; hex entry doesn't use shift) |
| `-` / `=` | Previous / next sample (clamped to 1–31) |

### Pattern editing

| Shortcut | Action |
| --- | --- |
| Backspace | Delete the cell on the row above on this channel and pull subsequent rows up |
| Enter | Insert an empty cell on this channel, pushing subsequent rows down |

### Order list

| Shortcut | Action |
| --- | --- |
| < / > (Shift+, / Shift+.) | Previous / next pattern at the current slot. `>` auto-creates a new empty pattern when stepping past the last existing one |
| ⌘I | Insert a new order slot at the cursor (duplicates the current slot's pattern number) |
| ⌘D | Delete the order slot at the cursor |
| ⌘B | Append a fresh empty pattern and point this slot at it |
| ⌘⇧B | Duplicate the current pattern (copy of its rows) and point this slot at the copy |

## Layout

```
src/
  core/
    mod/         Format types, period table, parser, writer, mutations,
                 sample importer
    audio/       Replayer + Paula (BLEP, filters, 2× downsampler), AudioWorklet,
                 offline renderer, WAV I/O
  state/         Solid signals: song + history, cursor, edit (octave / sample),
                 view (pattern | sample), grid config, shortcuts, io (export)
  components/    Solid components: PatternGrid, SampleList, SampleView
tests/
  ui/            jsdom + @testing-library component / keyboard tests
  fixtures/      .mod files + pt2-clone reference WAVs (gitignored, rebuilt
                 on first test run)
  lib/           Buffer-compare utility, render CLI
vendor/
  pt2-clone/     Cloned fresh on each build of vendor/bin/pt2-render
  headless/      Custom main.c + SDL2 shim for the headless build
  bin/           Built artifacts (pt2-render)
```

## Scripts

```bash
npm install
npm run dev                                # Vite dev server
npm run build                              # Production build (tsc + vite)
npm run typecheck                          # tsc --noEmit
npm run test                               # Full vitest suite
npm run test:watch                         # Vitest watch mode
npm run render -- input.mod output.wav     # Offline render via CLI
npm run fixtures:generate                  # Rebuild .mod test fixtures
npm run pt2-clone:build                    # Build vendor/bin/pt2-render
npm run fixtures:render                    # Render reference WAVs via pt2-render
```

## Generating reference WAVs from pt2-clone

The accuracy test compares our offline render against WAVs produced by pt2-clone.
See [`tests/fixtures/README.md`](tests/fixtures/README.md) for the exact command
line and conventions for naming fixtures.

## References

- [ProTracker 2.3D effects reference](https://wiki.openmpt.org/Manual:_Effect_Reference#MOD_effect_commands)
- [pt2-clone source](https://github.com/8bitbubsy/pt2-clone) — authoritative replayer
- Period table: see [`src/core/mod/format.ts`](src/core/mod/format.ts)
