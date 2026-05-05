# Sample pipeline & chiptune synth

Each sample slot in the editor has an optional **workbench** — a session-only chain that turns a source (a loaded WAV or a synthesised chiptune cycle) into the int8 PCM data PT expects:

```
  ┌──────────┐    ┌──────────────┐    ┌────────────────┐    Int8
  │  source  │ →  │  effect chain │ →  │ PT transformer │ ──→  data
  │ (WAV /    │    │ (gain, fade, │    │ (mono mix +    │    written
  │  chiptune)│    │  filter, …)  │    │  resample +    │    into
  └──────────┘    └──────────────┘    │  int8 quantise)│    song.samples[slot]
                                       └────────────────┘
```

Playback never touches the workbench — it reads the int8 data the chain wrote into the slot. The workbench is the editing surface; the int8 is the result.

The implementation lives at [src/core/audio/sampleWorkbench.ts](../src/core/audio/sampleWorkbench.ts) (chain + PT transformer + helpers) and [src/core/audio/chiptune.ts](../src/core/audio/chiptune.ts) (the chiptune source synth).

## SampleWorkbench shape

```ts
interface SampleWorkbench {
  source: SampleSource; // 'sampler' (WAV) | 'chiptune' (synth params)
  chain: EffectNode[]; // pure WavData → WavData fns, runs left-to-right
  pt: PtTransformerParams; // terminal mono+resample+quantise stage
  alt: WorkbenchAlt | null; // stash of the OTHER kind so toggle preserves both
}
```

State (`workbenches: Map<slot, SampleWorkbench>`) lives in [state/sampleWorkbench.ts](../src/state/sampleWorkbench.ts). Mutations go through `commitEditWithWorkbenches` so the chain UI and the slot's int8 move together — see [state.md](state.md#edit-history).

### Sources

```ts
type SampleSource =
  | { kind: "sampler"; wav: WavData; sourceName: string }
  | { kind: "chiptune"; params: ChiptuneParams };
```

`materializeSource(src)` is the only place that knows how to turn either kind into a `WavData`. The chain and PT stages are kind-agnostic.

`alt` stashes the other kind's full state (source + chain + pt + a snapshot of the slot's loop fields) so flipping Sampler ↔ Chiptune keeps both halves intact instead of throwing away the WAV when the user switches to chiptune. Session-only — never persists through `.retro`.

`sourceWantsFullLoop(src)` decides whether the slot's loop should span the whole result on first write. Chiptune sources are inherently looping; sampler results aren't.

### Effect nodes

The current effect set:

| `kind`      | Params                                           | Notes                                                 |
| ----------- | ------------------------------------------------ | ----------------------------------------------------- |
| `gain`      | `{ gain }`                                       | Whole-buffer.                                         |
| `normalize` | (none)                                           | Whole-buffer; no-op on silence.                       |
| `reverse`   | `{ startFrame, endFrame }`                       | Range-aware; outside the range, audio passes through. |
| `crop`      | `{ startFrame, endFrame }`                       | Keeps the range.                                      |
| `cut`       | `{ startFrame, endFrame }`                       | Removes the range.                                    |
| `fadeIn`    | `{ startFrame, endFrame }`                       | Linear 0→1 ramp inside the range only.                |
| `fadeOut`   | `{ startFrame, endFrame }`                       | Linear 1→0 ramp inside the range only.                |
| `filter`    | `{ type: 'lowpass'\|'highpass', cutoff: Hz, q }` | Biquad. Cutoff clamped to `[10, sampleRate/2)`.       |
| `crossfade` | `{ length }`                                     | Loop-aware: crossfades around the slot's loop point.  |
| `shaper`    | `{ mode: ShaperMode, amount: 0..1 }`             | Six modes — see below.                                |

Each is a pure `WavData → WavData` function (`applyGain`, `applyNormalize`, `applyReverse`, …). `applyEffect(effect, input, ctx)` dispatches by `kind`.

The whole chain:

```ts
runChain(input: WavData, chain: EffectNode[], ctx: RunContext): WavData;
```

`RunContext` carries the slot's loop bounds (in input-frame space) so loop-aware effects (currently just `crossfade`) can reach them without each effect carrying its own copy.

### PT transformer

The terminal stage. Always present, never user-removable.

```ts
interface PtTransformerParams {
  monoMix: "average" | "left" | "right";
  /** PT note slot 0..35 the result should play at "original speed", or null for no resample. */
  targetNote: number | null;
  resampleMode?: "linear" | "filteredLinear" | "sinc";
  dither?: boolean; // TPDF dither at ±1 LSB before int8 round
}
```

`transformToPt(audio, pt) → Int8Array`:

1. Mix to mono per `monoMix`.
2. Resample so the result's rate equals what Paula reads at the period for `targetNote` (`null` skips this — the source's rate is preserved).
3. Optionally TPDF dither.
4. Quantise to signed 8-bit.

Resample modes:

- **`linear`** — Hop-and-skip linear interpolation. Aliases on heavy downsamples but cheapest. Default for backward compat.
- **`filteredLinear`** — Two cascaded biquad LPFs at the new Nyquist, then linear. Inexpensive, audibly cleaner.
- **`sinc`** — Lanczos-6 windowed sinc polyphase. Sharp cutoff right at Nyquist. Best quality, most CPU — but it's a one-shot offline pass, latency doesn't matter.

`DEFAULT_TARGET_NOTE = 12` (C-2) is the conventional PT default. Fresh WAV imports go through `workbenchFromWav` with this target.

### runPipeline

```ts
runPipeline(wb: SampleWorkbench, ctx: RunContext): Int8Array;
```

Source → chain → PT → int8. This is what `App.tsx` calls in `commitEditWithWorkbenches` when a workbench changes. `App.writeWorkbenchToSong` then pushes the resulting int8 into the slot via `replaceSampleData`.

### Workbench constructors

| Function                                    | Use                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `workbenchFromWav(bytes, filename)`         | User dragged in a WAV file.                                                      |
| `workbenchFromWavData(wav, sourceName)`     | Already-parsed WAV.                                                              |
| `workbenchFromChiptune(params, sourceName)` | Switch slot to chiptune.                                                         |
| `workbenchFromInt8(data, sourceName)`       | Wrap a slot's existing int8 — no resample on output (the int8 IS the output).    |
| `emptySamplerWorkbench()`                   | Fresh empty sampler slot.                                                        |
| `defaultEffect(kind, input)`                | Sensible default params for each effect kind, sized to the current input length. |
| `workbenchToAlt(wb, loop?)`                 | Snapshot one half before a kind flip.                                            |

## Chiptune synth

[src/core/audio/chiptune.ts](../src/core/audio/chiptune.ts) — produces a single-cycle `WavData` that the workbench's chain + PT transformer treats like any other source. Pitch comes from PT's period × cycle length; the cycle is the entire sample (fully looped) and `pt.targetNote = null` so the resampler is a no-op.

### Parameters

```ts
interface ChiptuneParams {
  cycleFrames: number; // 8..256, snapped to powers of 2 → octave-aligned
  amplitude: number; // final scale 0..1
  osc1: Oscillator;
  osc2: Oscillator;
  combineMode: CombineMode; // morph | ring | am | fm | min | max | xor
  combineAmount: number; // 0..1 (0..2 for FM — modulation depth in radians)
  shaperMode: ShaperMode; // post-combine waveshaper
  shaperAmount: number; // 0..1, 0 = bypass
  lfo: Lfo; // primary LFO; defines rendered length
  lfo2: Lfo; // secondary LFO; cycleMultiplier divides lfo's
}

interface Oscillator {
  shapeIndex: number; // continuous [0..3]: sine→triangle→square→saw
  phaseSplit: number; // [0.05..0.95]: where the warped phase reaches 0.5 in the cycle
  ratio: number; // power-of-two — how many cycles fit in the base cycle
}

interface Lfo {
  cycleMultiplier: number; // power-of-two for lfo, divisor of that for lfo2
  amplitude: number; // 0..1; scaled by target's natural range
  target: LfoTarget; // which param it modulates
}
```

### Combine modes

| Mode    | Math                                             |
| ------- | ------------------------------------------------ |
| `morph` | `(1 − a)·o1 + a·o2` (level-preserving crossfade) |
| `ring`  | `(1 − a)·o1 + a·(o1·o2)` (ring modulation)       |
| `am`    | `o1 · (1 + a·o2)` (amplitude modulation)         |
| `fm`    | `o1` with phase modulated by `a · o2`            |
| `min`   | `(1 − a)·o1 + a·min(o1, o2)`                     |
| `max`   | `(1 − a)·o1 + a·max(o1, o2)`                     |
| `xor`   | 8-bit signed XOR, blended with `o1` by `a`       |

### LFO targets

`osc1Shape`, `osc1PhaseSplit`, `osc2Shape`, `osc2PhaseSplit`, `combineAmount`, `shaperAmount`, `amplitude`. The LFO generates a unipolar 0→1→0 triangle over the rendered output, scaled by `amplitude × target's natural range` (so amp 1.0 sweeps the full range regardless of target).

### Cycle / multiplier alignment

These constraints keep the result musically clean:

- `cycleFrames` snaps to powers of 2 (`MUSICAL_CYCLE_FRAMES`). A "C" note in a pattern always plays as some C, regardless of the slider position.
- Oscillator `ratio` snaps to `[1, 2, 4, 8]` — each step is an octave up.
- LFO 1's `cycleMultiplier` is any integer in `[1, 256]` — defines the rendered length (`baseLen × m1`). LFO 2's multiplier snaps to a divisor of `m1`, so LFO 2 completes `m1/m2` integer triangles inside the output and lands at phase 0 at every loop boundary.
- Worst-case rendered size is `256 × 256 = 65 536` bytes — half of PT's per-sample ceiling.

### Shape morphing

`morphShape(phase, idx)` blends sine ↔ triangle ↔ square ↔ saw at integer values, linearly interpolating between adjacent shapes for fractional `idx`. `splitPhase(t, split)` warps the phase so the cycle's midpoint lands at `split` instead of 0.5 — that's PWM on square, leaning ramp on triangle, asymmetric sine.

### Generator

`generateChiptuneCycle(params): WavData` — pure, deterministic. Same params in → same int8 out, which is why chiptune sources can persist as their tiny JSON in `.retro`: re-running the synth on load reproduces the slot's audio bit-for-bit.

`chiptuneFromJson(v): ChiptuneParams | null` — defensive parser for persisted blobs. Missing or bogus fields fall back to defaults; returns `null` on totally invalid input.

## Shapers

[src/core/audio/shapers.ts](../src/core/audio/shapers.ts) — six waveshaping modes used by both the chiptune synth (post-combine) and the sample-pipeline `shaper` effect:

| Mode         | Behavior                                                 |
| ------------ | -------------------------------------------------------- |
| `hardClip`   | `clamp(x, -1, 1)` — brick-wall.                          |
| `softClip`   | `tanh`-shaped.                                           |
| `wavefold`   | Triangle-fold: signal exceeding `[-1, 1]` reflects back. |
| `chebyshev3` | 3rd-order Chebyshev — adds a clean third harmonic.       |
| `chebyshev5` | 5th-order Chebyshev — adds clean third + fifth.          |
| `bitcrush`   | Quantises to discrete levels; amount ↔ bit depth.        |

`applyShaper(x, mode, amount)` — `amount` is a wet/dry blend, with `0 = bypass` and `1 = full effect` regardless of mode. Output is bounded to `[-1, 1]`.

## WAV reader/writer

[src/core/audio/wav.ts](../src/core/audio/wav.ts) — minimal RIFF/WAV PCM. `readWav(bytes): WavData` (8/16/24-bit int, 32-bit float, mono or stereo) and `writeWav(wav, bitDepth?: 16|24): Uint8Array`. Used by:

- The drag-and-drop sample importer ([sampleImport.ts](../src/core/mod/sampleImport.ts)).
- The persistence layer (16-bit PCM round-trip for sampler sources in `.retro`).
- The render CLI ([tests/lib/render-cli.ts](../tests/lib/render-cli.ts)).

```ts
interface WavData {
  sampleRate: number;
  channels: Float32Array[]; // 1 or 2
}
```

## Bounce-selection

[src/core/audio/bounce.ts](../src/core/audio/bounce.ts) — render a rectangular pattern selection (rows × channels) through `CleanMixer` and feed the resulting Float32 audio back as a fresh sampler source. The result lands in a sample slot via `workbenchFromWavData`, so the user can edit it, drop it through filters, or assign it to other slots.

It crops trailing silence based on the selection's exact duration, computed from per-row Fxx speed/tempo so a 2-row selection yields exactly 12 ticks of audio (at the standard speed=6) regardless of where the chunked render's 1024-frame buffers happened to land.

## Loop-truncate fix-up

ProTracker has a quirk: a sample with `loopStart=0` and `loopLength < sampleLength` plays once from `0..sampleLength`, then loops `0..loopLength` forever. Most editors assume the sample loops only `0..loopLength`, which sounds different.

[src/core/audio/loopTruncate.ts](../src/core/audio/loopTruncate.ts) — `truncateSampleAtLoopEnd(sample)` and `songForPlayback(song)`. Drops bytes past `loopEnd` for any looped sample, applied symmetrically to:

- The song the worklet plays (`engine.load` calls `songForPlayback`).
- The audition path (`engine.previewNote` calls `truncateSampleAtLoopEnd`).

The editor's stored `Song` keeps the full int8 — only the runtime path sees the truncated version. So the waveform editor still works on the full data.

## What persists, what doesn't

- **Chiptune sources persist.** `ChiptuneParams` is tiny JSON. The synth is deterministic, so re-running it after load reproduces the int8 bit-for-bit. The full chain + PT params persist alongside.
- **Sampler sources persist as 16-bit WAV bytes (base64).** Heavy, but worth it: round-tripping just the int8 would lose source fidelity (4× / 8× downsampling at write, no way back). 16-bit is well above the int8 PT quantizer, so storing wider buys no audible quality. A full chain + PT params persist alongside.
- **Workbenches don't persist into `.mod`** — only the resulting int8 lands there. A `.mod` save discards the chain; a `.mod` load wraps each non-empty slot via `workbenchFromInt8` so the user can still apply effects, but the original WAV / synth params are gone (use `.retro` to keep them).
- **The `alt` stash never persists.** It's a session-only convenience.
