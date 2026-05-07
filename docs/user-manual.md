# User manual

RetroTracker is a web-based ProTracker module editor: a four-channel pattern grid, a sample editor with a non-destructive effect chain, a chiptune synth, and a faithful Amiga Paula emulation that drives playback. This manual covers what each part does and how to drive it. For implementation details, see the [technical docs](README.md).

## Contents

- [Getting started](#getting-started)
- [Files and projects](#files-and-projects)
- [The four views](#the-four-views)
- [Pattern editing](#pattern-editing)
- [Order list](#order-list)
- [Samples](#samples)
- [Chiptune synth](#chiptune-synth)
- [Playback](#playback)
- [Channels: mute and solo](#channels-mute-and-solo)
- [Settings](#settings)
- [Keyboard reference](#keyboard-reference)

## Getting started

The latest build is always hosted at **<https://retrotracker.netlify.app/>** — open it in any modern browser and you're in. To run locally instead:

```bash
npm install
npm run dev
```

Open the URL Vite prints. Either way, the app boots with a blank "M.K." song so you can start editing immediately. Drop a `.mod` or `.retro` file onto the page (or use **File → Open**) to load existing work.

Your work autosaves to your browser's localStorage between every edit. Closing and re-opening the tab restores cursor position, view, sample workbenches, channel mute/solo, and everything else you can change in the editor. To save off-machine, use **File → Save…** which downloads a `.retro` project file.

## Files and projects

RetroTracker reads and writes three formats:

| Format     | What it stores                                                                    | When to use                                                           |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **.mod**   | Strict 4-channel "M.K." ProTracker module — playable in any tracker.              | Final delivery to anything outside RetroTracker.                      |
| **.retro** | The full editor session: song bytes + workbenches + channel mute/solo + UI state. | Saving work in progress so you can resume exactly where you left off. |
| **.wav**   | Rendered audio.                                                                   | Sharing the song as audio, or feeding it into a DAW.                  |

The **File** menu drives all of them:

- **New** — blank "M.K." song. Prompts before discarding unsaved changes.
- **Open…** (⌘O) — load a `.mod` or `.retro`. The app sniffs by extension.
- **Save…** (⌘S) — download a `.retro` project. Round-trips losslessly back into the editor.
- **Export .mod…** — strict 4-channel `.mod`. Other trackers can play it.
- **Export .wav…** — render the song to 16-bit stereo WAV at the current sample rate.

You can also drop a file directly onto the page; this is the fastest way to load.

### Why both `.mod` and `.retro`?

The `.mod` format only stores the 8-bit signed sample bytes that play back. It can't represent the **source** WAV you imported, the chain of effects you built around it, or the chiptune synth parameters. Save as `.retro` to keep all of those — open it later and the pipeline UI restores exactly as you left it. Export to `.mod` when you're done.

## The four views

Top of the window, switchable by tabs or function keys:

- **Pattern** (F2) — the main editor. Pattern grid in the centre, sample list on the left, order list on the right.
- **Sample** (F3) — sample editor. Same sample list on the left; the centre swaps to a waveform view + chain editor.
- **Info** (F4) — song title, file name, and free-form info text. Anything you type in info text is stamped into the sample-name slots on `.mod` export so it travels with the song.
- **Settings** (F5) — preferences (Paula model, color scheme, UI scale, stereo separation).

Sample selection (which slot is current) is shared across views. Switching from Sample to Pattern keeps your slot selected so the next note you type uses it.

## Pattern editing

The pattern grid shows 64 rows × 4 channels. Each cell is `note · sample · effect`:

```
C-3 17 C40
^   ^  ^^
|   |  effect command + param
|   sample slot (1..31, hex)
note (or "---" for empty)
```

### Cursor and navigation

- Arrow keys move the cursor cell-by-cell. Page Up / Down jumps a beat-bar.
- The cursor lives in one of six **fields** per cell: note, sample-hi, sample-lo, effect-cmd, effect-hi, effect-lo. Tab / Shift+Tab walks between channels at the same field.
- The cursor naturally walks across pattern boundaries — the grid is virtualised so big songs scroll smoothly.

### Note entry

The home row is a piano keyboard:

| Row                       | Notes                        |
| ------------------------- | ---------------------------- |
| `A W S E D F T G Y H U J` | C, C#, D, D#, … B (octave)   |
| `K O L P ;`               | C, C#, D, D#, E (octave + 1) |

`Z` / `X` shift the octave down / up. `Shift + piano key` previews a note without committing to the cell.

### Edit step

The cursor advances by **edit step** rows after a note is entered. `< / >` decrement / increment, `/` resets to 1.

### Selection, copy, paste

- `Shift + arrows` extends a selection rectangle from the cursor.
- `Cmd+C` / `Cmd+V` / `Cmd+X` copy / paste / cut the selection.
- `Esc` clears it.
- `Cmd+E` **bounces** the selection to a new sample slot — renders just those rows × channels through a clean (non-Paula) mixer, drops the result into the next free slot as a sampler workbench.

### Effects

Standard ProTracker effects `0xx..Fxx` and most extended `Exy`. For unfamiliar codes, open the Pattern view's right rail (PatternHelp): each effect on the active row is named there with its parameter decoded.

## Order list

Right rail of the Pattern view. The order list is the **playback sequence** — a list of slots, each pointing to a pattern. The active slot during playback is highlighted; the cursor's slot has a separate highlight when stopped.

### Navigating

- Click a slot to jump to it. **During playback this re-routes audio immediately** to that slot's row 0 — you don't have to stop first.
- `[` / `]` move the active position back / forward by one slot. (During playback, this re-routes audio; when stopped, it moves the cursor.)

### Stepping the slot pattern

- `Shift + [` / `Shift + ]` change which pattern the current slot points to. The pattern array auto-grows when you step past the last existing one.
- The toolbar above the order list has matching `‹` / `›` buttons.

### Adding and removing slots

- `Cmd + ]` (toolbar `+`) inserts a new slot, duplicating the active slot's pattern number.
- `Cmd + [` (toolbar `−`) deletes the active slot.
- `Alt + [` (toolbar `New`) appends a fresh blank pattern and points the active slot at it.
- `Alt + ]` (toolbar `Dup`) appends a copy of the active slot's pattern.

All of these stay live during playback. Audible changes apply on the next play / restart, except for slot-pattern stepping (`Shift + [` / `Shift + ]`), which the worklet picks up on the next row tick (typically tens of ms).

### Pattern names

Double-click any slot to rename the pattern it points at. Names are project-only — they live in `.retro` and never go into the exported `.mod`. Useful for tagging "intro", "verse", "drop", etc. when a song has many patterns.

### Clean up

The toolbar's **Clean up** button renumbers patterns in order of first appearance and discards unused ones — example: `[4, 5, 0, 0, 1]` becomes `[0, 1, 2, 2, 3]` over four patterns. Disabled during playback (it would renumber patterns the audio engine still references).

## Samples

The left rail in both Pattern and Sample views shows 31 sample slots numbered `1..31` (in hex: `01..1F`). Click a slot to make it current. Type `1..0` (top number row) for slots 1..10; `Shift + 1..0` for 11..20. `Alt + Up` / `Alt + Down` step prev / next.

### Loading a WAV

Drop a `.wav` onto the app and it lands in the next free slot. **If the Sample view is already open, the WAV replaces the current slot** instead — useful when you want to swap the source without searching for a free slot first. Supports 8 / 16 / 24-bit integer and 32-bit float WAVs, mono or stereo.

The full source is preserved at its original quality. Only the final 8-bit signed PT-quantised version is what playback hears; you can edit the chain that produces it without losing source quality.

### The Sample view

Two halves:

- **Top — waveform + meta.** Click and drag in the waveform to make a selection. `Cmd+A` selects the whole sample. Hovering the waveform shows the frame number and the equivalent `9xx` sample-offset effect parameter (capped at `9FF`).
- **Bottom — pipeline.** A chain of effect nodes, each non-destructive. The terminal node is the **PT transformer** which mixes to mono and quantises to 8-bit signed.

Each pipeline node has its own params — gain (dB), fade duration, crop bounds, normalise target, filter cutoff/resonance, shaper amount, etc. Reorder by drag, disable with the toggle, remove with `×`.

### Loop

The loop checkbox above the waveform turns the loop region on / off. With a selection active, enabling adopts the selection as the loop range. Without one, it loops the whole sample. **Disabling stashes the previous loop bounds**, so re-enabling restores them — you don't lose the loop you carefully placed.

Loop edits are allowed mid-playback. The worklet re-latches Paula's voice on the next DMA wrap (within one loop period), so you can dial the loop in by ear while the song is running.

### Crossfade

Add a crossfade effect to soften loop boundaries. Its length parameter is in frames. The crossfade re-renders whenever you move the loop bounds — no need to remove and re-add the effect.

### Other tools

- **Select all / Crop** — `Cmd+A` then crop trims the sample to the selection.
- **Reverse** — flips the sample byte-wise.
- **Bounce selection to sample** (Edit menu, `Cmd+E`) — see Pattern editing.

## Chiptune synth

A second source kind for any sample slot. Switch the slot's source from "sampler" to "chiptune" via the source-kind toggle in the pipeline editor, and the upper half swaps to a synth panel.

Two oscillators with:

- **Shape** — morphs across sine / triangle / square / pulse / sawtooth.
- **Phase split** — two-pole VCA-style phase manipulation.
- **Ratio** — frequency multiplier relative to oscillator 1.

Combine modes: **morph, ring, AM, FM, min, max, XOR**. Two LFOs modulate any of the slot's parameters.

The result is rendered into the slot's int8 data and plays back like any other sample. Edits are live during playback — drag a slider with the song running and you'll hear the morph within one loop period.

The chiptune source persists in the `.retro` project (the synth is deterministic, so a tiny JSON of params reproduces the int8 exactly on load). The `.mod` export carries only the rendered bytes.

## Playback

Transport buttons at the top: **Play song**, **Play pattern (loop)**, **Stop**.

| Shortcut            | Action                   |
| ------------------- | ------------------------ |
| Space               | Play song / Stop         |
| Alt + Space         | Play pattern (loop)      |
| Shift + Space       | Play song from cursor    |
| Alt + Shift + Space | Play pattern from cursor |

The **playhead** row is highlighted in the grid; per-channel VU meters above each column track real-time peaks.

### Live editing during playback

Most edits stay live while the song plays:

- **Sample/synth edits** — chiptune sliders, sampler chain effects, crop, loop adjust, sample-meta tweaks. Changes are pushed to the worklet's voice latches and audibly snap into the next loop wrap.
- **Order edits** — slot stepping, insert / delete, new / duplicate pattern. Audible on the next row tick.
- **Order list jump** — clicking a slot or pressing `[` / `]` retargets playback to that slot's row 0 without stopping.
- **Song title / file name / info text** — metadata only, instantly editable.
- **Channel mute / solo** — instant.

What's still gated during playback:

- **Pattern-cell edits** — would race the worklet mixing the same data.
- **Clean up** in the order list — renumbers patterns the worklet's snapshot still references.
- **Undo / redo** — same race condition as pattern-cell edits.

Stop playback (Space) when you need to do any of those.

## Channels: mute and solo

The channel header above each pattern column has two buttons. Or use the keyboard:

| Shortcut                 | Action                |
| ------------------------ | --------------------- |
| Alt + 1, 2, 3, 4         | Mute / unmute channel |
| Alt + Shift + 1, 2, 3, 4 | Solo / unsolo channel |

When at least one channel is solo'd, only solo'd channels are audible (mute is overridden). Both states **persist in `.retro` projects** and survive a browser refresh.

## Settings

F5 or the Settings tab. Preferences live in their own localStorage key — they travel with the user, not the song.

- **Paula model** — `A1200` (brighter, default) or `A500` (warmer with the analog low-pass).
- **Stereo separation** — 0% (mono) to 100% (full Amiga hard-pan). pt2-clone's default is 20%.
- **Color scheme** — `default`, `light`, `high-contrast`, `amber`.
- **UI scale** — 75% to 150%.

Paula model and stereo separation apply mid-playback in real time.

## Keyboard reference

The full list lives in the Pattern view's right rail (PatternHelp pane), localised to your keyboard layout. Highlights:

### Note entry

| Keys                      | Action                   |
| ------------------------- | ------------------------ |
| `A W S E D F T G Y H U J` | Piano (current octave)   |
| `K O L P ;`               | Piano (octave + 1)       |
| Shift + piano key         | Preview note (no commit) |
| `Z` / `X`                 | Octave − / +             |
| `.`                       | Clear field              |
| Backspace                 | Pull cell up             |
| Shift + Backspace         | Pull row up              |
| Return                    | Push cell down           |
| Shift + Return            | Push row down            |

### Edit step

| Keys      | Action               |
| --------- | -------------------- |
| `<` / `>` | Edit step − / +      |
| `/`       | Reset edit step to 1 |

### Order list

| Keys              | Action                          |
| ----------------- | ------------------------------- |
| `[` / `]`         | Previous / next order in song   |
| Shift + `[` / `]` | Previous / next pattern at slot |
| Cmd + `[`         | Delete order slot               |
| Cmd + `]`         | Insert order slot               |
| Alt + `[`         | New blank pattern at slot       |
| Alt + `]`         | Duplicate pattern at slot       |

### Samples

| Keys            | Action                   |
| --------------- | ------------------------ |
| `1..0`          | Select samples 1..10     |
| Shift + `1..0`  | Select samples 11..20    |
| Alt + Up / Down | Previous / next          |
| Cmd + A         | Select all (in waveform) |

### Playback

| Keys                | Action                   |
| ------------------- | ------------------------ |
| Space               | Play song / Stop         |
| Alt + Space         | Play pattern (loop)      |
| Shift + Space       | Play song from cursor    |
| Alt + Shift + Space | Play pattern from cursor |

### Channels

| Keys                     | Action |
| ------------------------ | ------ |
| Alt + 1, 2, 3, 4         | Mute   |
| Alt + Shift + 1, 2, 3, 4 | Solo   |

### File and history

| Keys                         | Action                     |
| ---------------------------- | -------------------------- |
| Cmd + O                      | Open                       |
| Cmd + S                      | Save (.retro)              |
| Cmd + Z                      | Undo                       |
| Cmd + Shift + Z (or Cmd + Y) | Redo                       |
| Cmd + C / V / X              | Copy / paste / cut         |
| Cmd + E                      | Bounce selection to sample |

### Views

| Keys | View     |
| ---- | -------- |
| F2   | Pattern  |
| F3   | Sample   |
| F4   | Info     |
| F5   | Settings |

The position-mapped shortcuts (piano keys, `Z` / `X`, `<` / `>`, `[` / `]`) match the **physical key positions** on a US QWERTY keyboard. On other layouts the keycap label changes but the position stays the same — so an AZERTY user pressing the QWERTY-A position fires the same shortcut even though their keycap shows `Q`. The PatternHelp pane shows your actual keycap labels.
