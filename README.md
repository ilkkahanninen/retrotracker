# RetroTracker

[![CI](https://github.com/ilkkahanninen/retrotracker/actions/workflows/ci.yml/badge.svg)](https://github.com/ilkkahanninen/retrotracker/actions/workflows/ci.yml)

A web-based tracker — edit ProTracker `.mod` (4-channel "M.K.") and FastTracker 2 `.xm` (up to 32 channels, 128 instruments) modules from the same editor.

## Features

- **Faithful Paula emulation.** The Amiga sound chip is reproduced sample-for-sample against the reference replayer, including BLEP synthesis, the analog RC filters, and the LED tone filter.
- **ProTracker and FastTracker 2 support.** Open a `.mod` or `.xm`, edit it, save it back. PT mode keeps the strict 4-channel "M.K." constraint; FT2 mode unlocks variable channel count (up to 32), per-pattern row count, 128 instruments with nested samples, the volume column, and the extended Gxx..Xxx effect set.
- **Native project format.** A `.retro` project file preserves everything the underlying `.mod` / `.xm` can't: high-fidelity source samples, the editing pipeline you built around them, chiptune-synth parameters. Open it later and pick up exactly where you stopped.
- **Non-destructive sampler.** Loaded WAVs (8 / 16 / 24-bit integer, float32, mono or stereo) are kept at full quality. Each slot owns a chain of effects — gain, normalise, reverse, crop, fade in / out — that you can reorder, disable, or remove at any time. Only the final 8-bit signed result is what playback hears; the source and the chain stay editable.
- **Chiptune synth.** Build cycles inside the editor itself: two oscillators with shape, phase-split and ratio controls, two LFOs, several combine modes (morph, ring, FM, and friends), and an optional waveshaper. Output is rendered into a sample slot so it plays back like any other instrument.
- **Optional cloud storage and shareable links.** When the deployment runs the bundled backend, signed-in users can save songs to a private bucket and mint `/share/<token>` links anyone can open in their own browser — recipients can save a copy to their own cloud with one click. The frontend stays a static SPA when the backend isn't running. See the [user manual's cloud section](docs/user-manual.md#cloud-and-sharing) for the user flow and [CLAUDE.md](CLAUDE.md#optional-backend) for the operator setup.

## Getting started

The latest build is always live at **<https://retrotracker.partyboi.app/>** — open it in any modern browser, drop a `.mod`, `.xm`, or `.retro` onto the page (or use **File → Open**), and start editing.

To run locally:

```bash
npm install
npm run dev
```

Open the URL Vite prints and use the editor the same way.

### Run with Docker

```bash
docker run --rm -p 8080:80 ghcr.io/ilkkahanninen/retrotracker:latest
```

Then open <http://localhost:8080>

## Documentation

- [User manual](docs/user-manual.md) — what each part does and how to drive it (views, pattern editing, samples, chiptune synth, playback, keyboard reference).
- [Technical docs](docs/README.md) — architecture, audio engine, MOD format, state, components, sample pipeline, testing.

## Thanks

RetroTracker stands on the shoulders of others. In particular:

- **Olav "8bitbubsy" Sørensen** — for [pt2-clone](https://github.com/8bitbubsy/pt2-clone), the authoritative open-source ProTracker 2.3D implementation. RetroTracker's replayer matches its behaviour effect-for-effect, and pt2-clone's binary is the reference our accuracy test bed compares against on every build.
- **aciddose** — for the minimum-phase BLEP table used by the BLEP synthesis path. Without this, sample transitions would alias audibly at higher pitches.
- **Lars "Zap" Hamre** and the original ProTracker team — for the file format and effect set that has anchored four-channel tracker music since 1990.
- The maintainers of **Solid.js** and **Vite**, which power the editor's UI and build pipeline.
