# RetroTracker — Technical Documentation

A web-based ProTracker `.mod` editor: Solid + Vite + TypeScript, scoped strictly to 4-channel "M.K." modules. The replayer is the centerpiece — a pure state machine that drives both an `AudioWorkletProcessor` for live playback and an offline renderer for the accuracy test bed.

These documents cover the engineering picture: how the audio path is structured, what data the editor manipulates, where state lives, and how the test bed validates that the replayer matches pt2-clone.

## Contents

- [01. Architecture overview](architecture.md) — module boundaries, data flow, top-level invariants.
- [02. Audio engine & replayer](audio-engine.md) — Replayer, Paula, mixers, worklets, offline render, `AudioEngine`.
- [03. MOD format & data model](mod-format.md) — `Song` / `Pattern` / `Note` / `Sample`, parser, writer, mutations, period table, effect codes.
- [04. State management](state.md) — Solid signals, history, persistence, transport.
- [05. UI components](components.md) — `App.tsx` layout, views, pattern grid, sample editor, chiptune editor.
- [06. Sample pipeline & chiptune synth](sample-pipeline.md) — `SampleWorkbench`, effect nodes, PT transformer, chiptune oscillators.
- [07. Testing & accuracy bed](testing.md) — vitest layout, fixtures, pt2-clone reference, render-accuracy comparison.

## Conventions used in these docs

- Code references use `path:line` format so they're greppable: `src/core/audio/replayer.ts:120`.
- "PT" = ProTracker. "M.K." = the 4-channel signature in the .mod header. "Paula" = the Amiga sound chip we emulate.
- "pt2-clone" refers to [8bitbubsy/pt2-clone](https://github.com/8bitbubsy/pt2-clone), the reference replayer we measure ourselves against. Effect behavior is bug-for-bug compatible.

## Related files

- [README.md](../README.md) — user-facing introduction.
- [CLAUDE.md](../CLAUDE.md) — short-form onboarding for AI agents working on the codebase.
- [tests/fixtures/README.md](../tests/fixtures/README.md) — the accuracy fixture catalog.
