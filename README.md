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
