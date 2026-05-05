# Audio engine & replayer

The audio path has six pieces, in dependency order:

```
            ┌─────────────────┐
            │  Replayer       │  pure state machine
            │  (replayer.ts)  │  (no DOM, no AudioContext)
            └────────┬────────┘
                     │ owns + drives
                     ▼
            ┌─────────────────┐
            │  Mixer (iface)  │  ── Paula      (analog character)
            │  (mixer.ts)     │  ── CleanMixer (bounce / clean offline)
            └────────┬────────┘
                     │ writes Float32 frames
                     ▼
   ┌─────────────────┴──────────────────┐
   ▼                                    ▼
┌────────────┐                  ┌────────────────┐
│ worklet.ts │ live playback    │ offlineRender  │ tests + render CLI
│ AudioWNode │  (44.1/48 kHz)   │  (Node)        │
└─────┬──────┘                  └────────────────┘
      │ port.postMessage
      ▼
┌────────────┐
│ engine.ts  │ main-thread wrapper
└────────────┘
```

The `Replayer` is the only thing that knows ProTracker. The mixer is the only thing that knows DSP. Anything that calls `process()` gets PT-correct mixed audio; anything that calls into the mixer gets correctly emulated DMA.

## Replayer

[src/core/audio/replayer.ts](../src/core/audio/replayer.ts) — ~1100 LoC of tracker logic.

### Public surface

```ts
class Replayer {
  constructor(song: Song, opts: ReplayerOptions);
  process(left: Float32Array, right: Float32Array, frames: number, offset: number): void;
  setChannelMuted(channel: number, muted: boolean): void;
  setAmigaModel(model: AmigaModel): void;
  setStereoSeparation(sep: number): void;
  hasEnded(): boolean;
  getOrder(): number;
  getRow(): number;
  getChannelLevels(): number[]; // 4-element peak buffer
}
```

`process()` writes interleaved-by-buffer Float32 samples into `left` and `right` at `offset`, for `frames` frames. It alternates `mixChunk()` (drives Paula for some number of frames) with `advanceTick()` (per-tick effects, row advancement, song state).

### Tick scheduling

ProTracker uses CIA-timer math for tick rate:

```
tickHz = 709379 / (floor(1773447 / BPM) + 1)
```

The replayer keeps a fractional-sample accumulator so the gap between ticks tracks pt2-clone exactly even at non-integer tick lengths. The `Fxx` tempo command is **deferred by one tick** — the CIA chip doesn't reload its timer until the next interrupt, so tempo only takes effect on the boundary after the row that changes it. This is a pt2-clone quirk, intentionally preserved.

### Effect coverage

All standard effects `0xx..Fxx` and most extended `Exy`. Notable PT-specific behaviors (all per pt2-clone):

| Effect           | Quirk                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `Dxx` PatternBreak | Param is decimal-encoded (`Dxy` jumps to row `x*10 + y`), not hex.            |
| `E0x` SetFilter    | LED filter — `E00 = on`, `E01 = off`. Off by default.                         |
| `E3x` Glissando    | Tone-portamento snaps to PERIOD_TABLE entries; basePeriod stays smooth.       |
| `E4x` VibratoWaveform | Value 3 also = square (PT2.3D bug, preserved).                             |
| `E7x` TremoloWaveform | Ramp tremolo uses `vibratoPos` for half-check (PT bug, preserved).         |
| `E5y` SetFinetune  | Applied **before** period lookup so the new finetune affects the same row.    |
| `E9y` Retrigger    | Period reload on retrigger uses base period, not the vibrated effective.      |
| `EC0` NoteCut      | Cuts at tick 0 via the `setPeriod → checkMoreEffects` path.                   |
| `ECy` NoteCut      | Sets volume = 0 at tick `y`; leaves period alone.                              |
| `EFy` InvertLoop   | Bit-inverts loop-region bytes **destructively** in place — re-parse to clean. |
| `Fxx` SetSpeed     | `< 0x20`: speed (ticks/row). `>= 0x20`: tempo (BPM), deferred 1 tick.         |

Period clamp is `[113, 856]` — the original Amiga DMA hardware limit. Notes outside this range are clamped at trigger.

**Not implemented (intentional):** `8xy` panning. PT 2.3D ignores it; the `06-panning` accuracy fixture verifies we agree.

### Channel state

Each of the 4 channels holds:

- Active sample (`sampleNum`, `playing` flag).
- Pitch (`period`, `basePeriod`, `finetune`, `noteIndex`).
- Volume (`volume`, plus a per-tick `effectiveVolume` override for tremolo).
- Effect memory: portamento targets, vibrato/tremolo speed/depth/pos, waveform control, glissando, funkrepeat (`EFy`), invert-loop byte cursor, packed `Axx` slide, arp nibbles, `9xy` offset, retrigger interval, note-cut/note-delay tick counters, pending note buffer.
- Pattern loop bookkeeping (`E6x`).
- DMA marshalling: `pendingTrigger`, `pendingStartOffsetBytes`, `pendingStop` — applied on the next mixer sync so DMA writes happen at frame boundaries.

### Song state

`speed`, `tempo`, `tickInRow`, `row`, `orderIndex`, `patternDelay`, `jumpToOrder`/`jumpToRow`, `ended`, `visited` (a `Set<number>` keyed by `(orderIndex << 8 | row)` for song-end detection), and `pendingTempo` (CIA reload quirk).

Song-end is detected by a revisit to a `(order, row)` already in the visited set during a forward step (i.e., not via `Bxx`). With `loop: true` (the live-playback default), the visited check is skipped — `Bxx` to an earlier row is treated as the song's loop point, and falling off the end wraps to order 0. With `loop: false` (offline render), `hasEnded()` flips and the renderer cuts.

`loopPattern` (used by F7 "Play pattern") locks playback to a single pattern: the visited check is skipped, end-of-pattern wraps to row 0, `Bxx` is clamped to the current order, `Dxx` jumps within the pattern.

### Replayer options

See [src/core/audio/types.ts](../src/core/audio/types.ts):

```ts
interface ReplayerOptions {
  sampleRate: number;          // 44100, 48000, …
  clock?: 'PAL' | 'NTSC';      // PAL is the PT default
  initialSpeed?: number;       // default 6
  initialTempo?: number;       // default 125 BPM
  stereoSeparation?: number;   // 0..100; pt2-clone default 20
  loop?: boolean;              // live: true, offline: false
  initialOrder?: number;
  initialRow?: number;
  loopPattern?: boolean;       // F7 mode
  mixerFactory?: (sampleRate: number) => Mixer;
  amigaModel?: AmigaModel;     // 'A500' | 'A1200', default 'A1200'
}
```

## Mixer interface

[src/core/audio/mixer.ts](../src/core/audio/mixer.ts) — the DMA-shaped contract every mixer implements:

```ts
interface Mixer {
  setSample(channel, data: Int8Array, loopStartBytes, loopLengthWords): void;
  setPeriod(channel, period: number): void;
  setVolume(channel, volume: number): void;
  startDMA(channel, byteOffset?: number): void;
  stopDMA(channel): void;
  generate(left: Float32Array, right: Float32Array, frames: number, offset: number): void;
  setLEDFilter(on: boolean): void;
  setStereoSeparation(sep: number): void;
}
```

The replayer never branches on which mixer is active. Two implementations:

### Paula

[src/core/audio/paula.ts](../src/core/audio/paula.ts) — direct port of pt2-clone's audio path. Per-output-sample pipeline:

1. **4 voices at 2× mix rate.** Phase-driven sample-and-hold playback (no waveform interpolation between bytes — the original chip didn't have any). Discontinuities at byte transitions are corrected by **minimum-phase BLEP impulses** added to a circular buffer (`Blep.add`) and convolved on output (`Blep.run`). The BLEP table is aciddose's from `pt2_blep.c` — ZC=16, OS=16, SP=16, NS=16.
2. **Sum into hard-panned L/R (LRRL).** Channels 0 and 3 hard-left, 1 and 2 hard-right.
3. **RC filters** at the 2× rate:
   - One-pole high-pass (always on).
   - One-pole low-pass (A500 only — the brighter A1200 omits this).
   - Two-pole LED filter (when `E00` enables it).
4. **Polyphase half-band FIR downsample** to the output rate.
5. The caller (the replayer) applies stereo separation and final scaling.

`AmigaModel` is `'A500' | 'A1200'`. The two differ only in the low-pass stage — A500 has the warmer brick-wall, A1200 doesn't.

### CleanMixer

[src/core/audio/cleanMixer.ts](../src/core/audio/cleanMixer.ts) — high-quality offline mixer without analog character. Linear interpolation, faithful loop wrapping, no BLEP, no filters. Used by the **bounce-selection** path so users get a clean sample free of Paula aliasing artifacts. Selectable via `mixerFactory` in `ReplayerOptions`.

## Drivers

### Live playback: `engine.ts` + `worklet.ts`

[src/core/audio/engine.ts](../src/core/audio/engine.ts) is the main-thread wrapper. Construction is async because we have to `await ctx.audioWorklet.addModule(workletUrl)`:

```ts
const engine = await AudioEngine.create();
engine.load(song);          // postMessage: load
await engine.play();        // postMessage: play
engine.onPosition = (order, row) => { /* … */ };
engine.onLevels   = (peaks)         => { /* … */ };
```

Public methods are 1:1 with the message types:

- `load(song)`, `play()`, `playFrom(order, row, { loopPattern })`, `stop()`
- `setChannelMuted(ch, muted)`
- `setPaulaModel(model)`, `setStereoSeparation(sep)` — both forwarded to the song worklet AND any active preview worklet, with the values cached on the engine so a preview worklet built later still picks up the right state.
- `previewNote(sample, period)`, `stopPreview()` — see "Preview worklet" below.
- `dispose()`.

The worklet ([src/core/audio/worklet.ts](../src/core/audio/worklet.ts)) is an `AudioWorkletProcessor` that owns a `Replayer` and proxies tracker commands across the `MessagePort`:

| Main → worklet              | Worklet → main                              |
| --------------------------- | ------------------------------------------- |
| `load { song }`             | `pos { order, row }` (on row crossings)     |
| `play`                      | `level { peaks: number[4] }` (~30 Hz)       |
| `playFrom { order, row, loopPattern }` |                                  |
| `stop`                      |                                             |
| `setChannelMuted { ch, muted }` |                                         |
| `setAmigaModel { model }`   |                                             |
| `setStereoSeparation { sep }` |                                           |

The worklet caches mute gates, Paula model, and stereo separation so they survive the `Replayer` recreation that happens at song-end loop. Live playback never reports end-of-song to the main thread — when the replayer ends, the worklet rebuilds it with `loop: true` and keeps mixing, so transport state stays consistent.

The "lazy AudioContext" pattern in [state/playback.ts](../src/state/playback.ts) means `AudioEngine.create()` only runs after the first user gesture (or test stub). On creation, the orchestration layer pushes the cached mute/Paula/stereo state into the worklet so anything the user toggled before audio existed lands correctly.

### Offline render: `offlineRender.ts`

[src/core/audio/offlineRender.ts](../src/core/audio/offlineRender.ts) loops `replayer.process()` into Float32 buffers in 1024-frame chunks, stopping on `replayer.hasEnded()` or the `maxSeconds` cap, whichever comes first. Used by:

- The accuracy test bed ([tests/render-accuracy.test.ts](../tests/render-accuracy.test.ts) and [tests/render-accuracy-a500.test.ts](../tests/render-accuracy-a500.test.ts)).
- The `render` CLI: `npm run render -- in.mod out.wav [--seconds=N] [--rate=44100]` ([tests/lib/render-cli.ts](../tests/lib/render-cli.ts)).

Returns `{ sampleRate, left, right }` as `Float32Array` pairs — no WAV envelope; the CLI wraps it.

### Preview worklet

[src/core/audio/preview-worklet.ts](../src/core/audio/preview-worklet.ts) is a single-Paula-voice worklet for sample auditioning in the sample editor. The voice has hot-swappable sample data: while a key is held, slider drags on the chiptune editor or pipeline params re-`postMessage` the new int8 buffer and the worklet patches it in place. BLEP filter state survives the swap, so there's no click — the user hears one continuous voice morph.

It routes through the same RC/LED/stereo-separation chain as the song worklet, so loudness and spectral character match what playback will sound like.

## The loop-truncate fix-up

[src/core/audio/loopTruncate.ts](../src/core/audio/loopTruncate.ts) — addresses ProTracker's `loopStart=0, loopLength<sampleLength` quirk. In PT, samples with that shape play once from `0..sampleLength` then loop `0..loopEnd` forever; the editor's preview should match what playback sounds like.

`songForPlayback(song)` rewrites every looped sample to drop bytes past `loopEnd`. It's applied only when feeding the worklet — the editor's stored `Song` keeps the full int8 so the waveform UI stays editable. Applied symmetrically in `AudioEngine.previewNote` so the audition path agrees with song playback.

## Bounce-selection

[src/core/audio/bounce.ts](../src/core/audio/bounce.ts) renders user-selected pattern rows × channels through `CleanMixer` and crops trailing silence based on the selection's tail (so a 2-row selection at speed 6 yields exactly 12 ticks of audio, not whatever buffer length the chunked render produced). The result is fed back through the sample pipeline as a fresh source so it lands in a sample slot.

## Other audio utilities

- **[wav.ts](../src/core/audio/wav.ts)** — minimal RIFF/WAV PCM reader/writer. Reads 8 / 16 / 24-bit integer and 32-bit float, mono or stereo. Writes 16-bit. Used by sample import, persistence (16-bit PCM round-trip for sampler sources in `.retro`), and the render CLI.
- **[shapers.ts](../src/core/audio/shapers.ts)** — six waveshaping modes (`hardClip`, `softClip`, `wavefold`, `chebyshev3`, `chebyshev5`, `bitcrush`). Used by both the chiptune synth and the sample-pipeline shaper effect. All modes are amount-aware (0 = bypass, 1 = full) and bounded to `[-1, 1]`.

## Reading the replayer source

Roadmap for navigating [replayer.ts](../src/core/audio/replayer.ts):

- The big comment at the top lists implemented effects and PT quirks.
- Constants: `SINE_TABLE`, `MIN_PERIOD`, `MAX_PERIOD`.
- `ChannelState` and `SongState` interfaces.
- `process()` is the entry point — it loops `mixChunk` ↔ `advanceTick`.
- `triggerNote` / `setPeriod` / `setVolume` are the per-channel apply paths; effect handlers (`applyTick0Effect`, `applyExtendedTick0`, `tickEffect`) fan out from there.
- DMA marshalling uses `pendingTrigger` / `pendingStartOffsetBytes` / `pendingStop` to defer mixer writes until the next sync, so the mixer always sees DMA changes at frame boundaries.

When adding a new effect: tick-0 setup goes in `applyTick0Effect` (or `applyExtendedTick0`), per-tick continuous behavior in `tickEffect`. Cross-check pt2-clone's source before assuming behavior — comments cite `pt_xxx.c` line numbers for the trickier paths.
