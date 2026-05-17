# User manual

RetroTracker is a web-based tracker that opens both ProTracker `.mod` (4-channel "M.K.") and FastTracker 2 `.xm` (variable channel count, up to 128 instruments) modules. PT and XM each get their own pattern grid, but share the sample editor, the non-destructive effect chain, the chiptune synth, and project save/load. PT playback runs through a faithful Amiga Paula emulation; XM goes through a parallel mixer. This manual covers what each part does and how to drive it. For implementation details, see the [technical docs](README.md).

## Contents

- [Getting started](#getting-started)
- [Files and projects](#files-and-projects)
- [Cloud and sharing](#cloud-and-sharing)
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

The latest build is always hosted at **<https://retrotracker.partyboi.app/>** — open it in any modern browser and you're in. To run locally instead:

```bash
npm install
npm run dev
```

Open the URL Vite prints. Either way, the app boots with a blank "M.K." song so you can start editing immediately. Drop a `.mod`, `.xm`, or `.retro` file onto the page (or use **File → Open**) to load existing work — the format is detected by file extension, and the editor switches into the matching mode automatically.

Your work autosaves to your browser's localStorage between every edit. Closing and re-opening the tab restores cursor position, view, sample workbenches, channel mute/solo, and everything else you can change in the editor — including the cloud bucket the song was loaded from or saved to, so **Share this song** stays available across reloads without re-saving. To save off-machine, use **File → Save to computer…** which downloads a `.retro` project file. To save to a remote bucket — and to share songs by link — see [Cloud and sharing](#cloud-and-sharing).

## Files and projects

RetroTracker reads and writes four formats:

| Format     | What it stores                                                                                        | When to use                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **.mod**   | Strict 4-channel "M.K." ProTracker module — playable in any tracker.                                  | Final delivery to anything outside RetroTracker on the PT side.       |
| **.xm**    | FastTracker 2 module — variable channel count, 128 instruments with nested samples, extended effects. | Final delivery on the FT2 side.                                       |
| **.retro** | The full editor session: song bytes + workbenches + channel mute/solo + UI state.                     | Saving work in progress so you can resume exactly where you left off. |
| **.wav**   | Rendered audio.                                                                                       | Sharing the song as audio, or feeding it into a DAW.                  |

The **File** menu drives all of them:

- **New** — blank "M.K." song (PT mode). Prompts before discarding unsaved changes.
- **Open…** (⌘O) — load a `.mod`, `.xm`, or `.retro`. The app sniffs by extension and switches mode.
- **Save…** (⌘S) — download a `.retro` project. Round-trips losslessly back into the editor.
- **Export .mod… / .xm…** — write the song back to its native format. Other trackers can play it.
- **Export .wav…** — render the song to 16-bit stereo WAV at the current sample rate.

You can also drop a file directly onto the page; this is the fastest way to load.

### Why both the tracker format and `.retro`?

Neither `.mod` nor `.xm` can represent the **source** WAV you imported, the chain of effects you built around it, or the chiptune synth parameters — they only store the final quantised sample bytes that play back. Save as `.retro` to keep all of those — open it later and the pipeline UI restores exactly as you left it. Export back to `.mod` / `.xm` when you're done.

## Cloud and sharing

Some deployments of RetroTracker (including the hosted build) also offer **cloud storage** and **shareable song links**. These only show up when the server you're connected to has them enabled — on a self-hosted build with the backend turned off, the File menu stays purely local. Nothing here is required to use the editor.

### Signing in

When auth is enabled, the File menu shows **Sign in to cloud…** until you do. Sign in once (the hosted build uses [Logto](https://logto.io/) — your browser bounces through their sign-in page and back), and the menu changes to show your name plus **Sign out**. Each signed-in user gets their own private bucket on the server — other users can't see your files.

### Open / save to cloud

After signing in (or on any deployment running in anonymous mode):

- **File → Open from cloud…** lists every `.retro` project and `.mod` / `.xm` module in your bucket, mixed into one chronological list — you don't have to remember which format you saved under. Click to load; the editor sniffs the format and switches modes automatically. ⌘O picks the cloud picker over the local file dialog when cloud is available.
- **File → Save to cloud…** writes the current song as `.retro` into your bucket. The default name is the song title; type a slash-separated path (e.g. `demos/intro.retro`) to organise into folders. ⌘S does the same thing.
- The **×** next to a file in the picker deletes it. There's no trash — gone is gone.

The hosted build caps each user at 100 MB and 500 share links by default; self-hosted deployments can adjust both.

### Sharing a song

Once a song lives in your cloud bucket, **File → Share this song…** mints a public link of the form `/share/<token>`. Anyone with the link can open the song in their own browser without signing in. The modal also lists every share link you've created — copy or revoke any of them from there. Revoking immediately invalidates the link.

What recipients can do:

- Open the song and play / edit it locally, like any drag-dropped file.
- If they're signed in (or sign in afterwards), **Save to cloud…** keeps a copy in **their** bucket — your original is untouched. They can save it under any name; you don't get notified.
- If they want to share their own remix, they have to save it to their own cloud first, then share from there. Receiving a share link doesn't give them re-share rights against your file.

What recipients can't do:

- Modify the original. The share is read-only.
- See your other files. The link points at exactly one song.

The link works until you revoke it — there is no automatic expiry. If you upload a new file at the same name, the link automatically points at the new bytes (it's keyed by path, not content). If you delete the source file, the link returns "shared file no longer exists" until you re-upload or revoke.

Heads-up: if a recipient hits the link while not signed in and _then_ tries to save a copy, they go through the full sign-in redirect, which navigates away from the page and loses the loaded song. The simplest workaround is to sign in **before** opening the link.

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

Each pipeline node has its own params — volume envelope shape, crop bounds, normalise target, filter cutoff/resonance, shaper amount, etc. Reorder by drag, disable with the toggle, remove with `×`.

### Envelopes (volume, filter, shaper, pitch)

Several effect params can be _automated_ across the sample using piecewise-linear envelopes of `n ≥ 2` points (frame, value). Click the effect in the chain to select it; an overlay appears on the waveform with draggable points and segments in the param's identity color:

- **Volume** (orange) — gain `0..2` (silence to ~+6 dB), `1.0` neutral. Replaces the older Gain / Fade In / Fade Out.
- **Filter cutoff** (cyan) — `10..22050 Hz`, log Y axis so the lower octaves get equal screen space.
- **Filter Q** (violet) — `0.1..20`, linear. Use the **Cutoff / Q** toggle in the filter chain entry to switch which envelope the overlay edits.
- **Shaper drive** (green) — `0..1`, linear.
- **Pitch** (pink) — playback-speed multiplier `0.25..4`, log Y. `1.0` is unchanged; `2.0` plays the sample twice as fast (one octave up, half the length); `0.5` half-speed (octave down, twice as long). The pitch effect changes the slot's int8 length — the output is variable, recomputed every time you drag a point.

Outside the points' frame range, the value clamps to the boundary point (DAW-style automation). Old projects with constant filter / shaper params auto-migrate to flat 2-point envelopes on load — schema bumps to v=7 (filter/shaper) or v=8 (pitch).

Interaction (same for every envelope):

- **Add a point**: double-click anywhere on the envelope or its segment.
- **Remove a point**: double-click the point. Endpoints can't be removed when only 2 remain.
- **Move a point**: drag it. Endpoint frames are pinned to the sample edges; only their value moves.
- **Raise / lower a flat region**: drag a segment line vertically — both endpoints move in value together.

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

The header transport is a single **Play / Stop** button plus three persisted toggles:

- **Song ↔ Pattern** segmented toggle — what Play starts: the whole song from row 0 or the cursor's pattern on loop.
- **Follow** toggle — when on (default), the pattern view auto-scrolls to keep the playhead centered and pattern editing is locked. When off, the view tracks the editing cursor instead and pattern edits commit live during playback (forwarded to the engine via the in-flight song snapshot).

Both toggles persist across sessions.

| Shortcut       | Action                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Space          | Play / Stop (from row 0 of the song or cursor's pattern, depending on the Song / Pattern toggle)             |
| Option + Space | Play from cursor row, or — when already playing — pause and snap the editing cursor to the playhead position |
| C              | Toggle Song / Pattern mode (PT2: note column only; FT2: note column only)                                    |
| V              | Toggle Follow playhead (FT2: anywhere except the effect-cmd column)                                          |

The **playhead** row is highlighted in the grid; per-channel VU meters above each column track real-time peaks.

### Live editing during playback

With **Follow off**, pattern-cell edits, transpose, clipboard ops, and undo / redo all commit live and the engine picks up the change on the next row processed.

The following stay live regardless of the Follow toggle:

- **Sample / synth edits** — chiptune sliders, sampler chain effects, crop, loop adjust, sample-meta tweaks. Changes are pushed to the worklet's voice latches and audibly snap into the next loop wrap.
- **Order edits** — slot stepping, insert / delete, new / duplicate pattern. Audible on the next row tick.
- **Order list jump** — clicking a slot or pressing `[` / `]` retargets playback to that slot's row 0 without stopping.
- **Song title / file name / info text** — metadata only, instantly editable.
- **Channel mute / solo** — instant.

What's still gated **only with Follow on**:

- **Pattern-cell edits, transpose, clipboard paste, undo / redo** — turn Follow off to release the lock.
- **Clean up** in the order list — renumbers patterns the worklet's snapshot still references; do this while stopped.

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

| Keys        | Action                                      |
| ----------- | ------------------------------------------- |
| Space       | Play / Stop (from row 0)                    |
| Alt + Space | Play from cursor / pause and snap cursor    |
| `C`         | Toggle Song / Pattern mode (note column)    |
| `V`         | Toggle Follow playhead (off ⇒ live editing) |

### Channels

| Keys                     | Action |
| ------------------------ | ------ |
| Alt + 1, 2, 3, 4         | Mute   |
| Alt + Shift + 1, 2, 3, 4 | Solo   |

### File and history

| Keys                         | Action                                            |
| ---------------------------- | ------------------------------------------------- |
| Cmd + O                      | Open (cloud picker when signed in, else local)    |
| Cmd + S                      | Save .retro (to cloud when signed in, else local) |
| Cmd + Z                      | Undo                                              |
| Cmd + Shift + Z (or Cmd + Y) | Redo                                              |
| Cmd + C / V / X              | Copy / paste / cut                                |
| Cmd + E                      | Bounce selection to sample                        |

### Views

| Keys | View     |
| ---- | -------- |
| F2   | Pattern  |
| F3   | Sample   |
| F4   | Info     |
| F5   | Settings |

The position-mapped shortcuts (piano keys, `Z` / `X`, `<` / `>`, `[` / `]`) match the **physical key positions** on a US QWERTY keyboard. On other layouts the keycap label changes but the position stays the same — so an AZERTY user pressing the QWERTY-A position fires the same shortcut even though their keycap shows `Q`. The PatternHelp pane shows your actual keycap labels.
