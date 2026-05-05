# MOD format & data model

The `Song` is the in-memory representation of a ProTracker M.K. module. It's plain TypeScript objects, immutable by convention (every mutation in [mutations.ts](../src/core/mod/mutations.ts) returns a new `Song`), and the source of truth for both playback and the editor UI.

## Data model

[src/core/mod/types.ts](../src/core/mod/types.ts):

```ts
const ROWS_PER_PATTERN = 64;
const CHANNELS = 4;
const NUM_SAMPLES = 31;
const MAX_ORDERS = 128;

interface Sample {
  name: string;            // 22-byte ASCII, null-padded
  lengthWords: number;     // length in 16-bit words; bytes = lengthWords * 2
  finetune: number;        // signed 4-bit, encoded 0..15 (8..15 = -8..-1)
  volume: number;          // 0..64
  loopStartWords: number;
  loopLengthWords: number; // <= 1 means "no loop"
  data: Int8Array;         // signed 8-bit PCM
}

interface Note {
  period: number;          // Paula period; 0 = no note
  sample: number;          // 1..31; 0 = no sample change
  effect: number;          // command nibble 0x0..0xF
  effectParam: number;     // parameter byte 0x00..0xFF
}

interface Pattern {
  rows: Note[][];          // [ROWS_PER_PATTERN][CHANNELS]
}

interface Song {
  title: string;           // 20-byte ASCII
  samples: Sample[];       // exactly 31 entries (samples 1..31; index 0 = sample #1)
  songLength: number;      // 1..128
  restartPosition: number; // historic NoiseTracker byte; PT writes 127
  orders: number[];        // length 128, padded with zeros past songLength
  patterns: Pattern[];     // unique patterns; count = max(orders) + 1
  signature: string;       // always "M.K."
}
```

Constants live in [types.ts](../src/core/mod/types.ts) — import them, don't hardcode `64` / `4` / `31` / `128`.

### Index conventions

- **Sample index 0 means "no sample change."** A note that triggers without a sample number plays through the channel's last-assigned sample. `samples[0]` is sample #1 in the file.
- **Period 0 means "no note."** A row with `period === 0` only applies effects.
- **Finetune is stored signed-as-unsigned.** Values 0..7 are `+0..+7`; values 8..15 are `-8..-1`. The `PERIOD_TABLE` in [format.ts](../src/core/mod/format.ts) is indexed directly by this stored value, so PT's encoding survives end-to-end without conversion churn.
- **`loopLengthWords <= 1` is "no loop."** PT writes `1`, some other writers write `0` — the parser preserves whichever it sees, the replayer treats both as no-loop.

## Binary format

The on-disk M.K. layout is fixed-size for the header + sample metadata, then variable-length pattern data, then sample audio:

```
Offset   Size    Field
0        20      title (ASCII, null-padded)
20       30×31   sample metadata (name 22B, lengthWords 2B, finetune 1B,
                 volume 1B, loopStartWords 2B, loopLengthWords 2B)
950      1       songLength
951      1       restartPosition (NoiseTracker; PT writes 127)
952      128     orders (pattern numbers; songLength..127 are padding zeros)
1080     4       signature ("M.K.")
1084     ...     pattern data: numPatterns × 64 × 4 × 4 bytes
                 numPatterns = max(orders) + 1
                 each cell encoded:  SSSSPPPPPPPPPPPP SSSSEEEEPPPPPPPP
                                     [s.hi][period 12][s.lo][eff][param]
?        ...     sample audio, in sample-number order (signed 8-bit PCM)
```

### Parser

[src/core/mod/parser.ts](../src/core/mod/parser.ts) — `parseModule(buf)`. Strict M.K. only; throws on any other signature.

- Validates header size (`>= 1084 bytes`).
- Reads the 31 sample slots, the 128-byte order list, and the signature.
- Computes `numPatterns = max(orders) + 1` and reads pattern data.
- Reads sample audio sequentially after the patterns; **truncates gracefully** when sample data is short (some MODs ship trimmed). Sample length metadata is preserved as-is even if `data.byteLength` is smaller — this matters for fixture round-trips.
- ASCII reads stop at the first NUL and skip non-printable bytes.

### Writer

[src/core/mod/writer.ts](../src/core/mod/writer.ts) — `writeModule(song)` — round-trips the parser. Writes header → patterns → sample audio in order. Output is byte-identical to a `parseModule(writeModule(song))` round-trip for any song authored through the mutations API.

## Effect codes

[src/core/mod/format.ts](../src/core/mod/format.ts) exposes both enums as `as const` objects:

### `Effect` (high nibble of effect byte)

| Code | Name                           |
| ---- | ------------------------------ |
| `0`  | Arpeggio                       |
| `1`  | SlideUp                        |
| `2`  | SlideDown                      |
| `3`  | TonePortamento                 |
| `4`  | Vibrato                        |
| `5`  | TonePortamentoVolumeSlide      |
| `6`  | VibratoVolumeSlide             |
| `7`  | Tremolo                        |
| `8`  | Unused (PT 2.3D ignores this)  |
| `9`  | SetSampleOffset                |
| `A`  | VolumeSlide                    |
| `B`  | PositionJump                   |
| `C`  | SetVolume                      |
| `D`  | PatternBreak (decimal-encoded) |
| `E`  | Extended (sub-command in hi-nibble of param) |
| `F`  | SetSpeed (`<0x20`) / SetTempo (`>=0x20`) |

### `ExtendedEffect` (high nibble of param when effect = `E`)

| Code | Name              | Notes                                                          |
| ---- | ----------------- | -------------------------------------------------------------- |
| `0`  | SetFilter         | LED filter; `00 = on`, `01 = off`                              |
| `1`  | FineSlideUp       |                                                                |
| `2`  | FineSlideDown     |                                                                |
| `3`  | Glissando         | Tone-porta snaps to PERIOD_TABLE entries                       |
| `4`  | VibratoWaveform   | 0=sine, 1=ramp, 2/3=square. Bit 2 = retain on note.            |
| `5`  | SetFinetune       | Applied **before** the period lookup on the same row           |
| `6`  | PatternLoop       | Per-channel loop-row + count                                   |
| `7`  | TremoloWaveform   | Same waveform encoding as E4x (uses `vibratoPos` for half — a PT bug, preserved) |
| `8`  | Unused            |                                                                |
| `9`  | Retrigger         |                                                                |
| `A`  | FineVolumeSlideUp |                                                                |
| `B`  | FineVolumeSlideDn |                                                                |
| `C`  | NoteCut           | Tick-based; `EC0` cuts at tick 0                                |
| `D`  | NoteDelay         |                                                                |
| `E`  | PatternDelay      | Repeats current row N more times                                |
| `F`  | InvertLoop        | Bit-inverts loop-region bytes destructively                     |

## Period table

[format.ts](../src/core/mod/format.ts) ships a 16×36 readonly table.

- Rows are finetune `0..15` (signed encoding — see above).
- Columns are notes `0..35`: C-1, C#1, …, B-3.
- Values are Paula periods. Playback rate on Paula is `clock / (period * 2)` where `clock` is `PAULA_CLOCK_PAL = 7093790.0` or `PAULA_CLOCK_NTSC = 7159090.75`.

The table comes from pt2-clone — keep it byte-identical. Look-ups always go through `PERIOD_TABLE[finetune]!` (the trailing `!` is the asserts the row exists; finetune is 0..15 by construction).

## Mutations

[src/core/mod/mutations.ts](../src/core/mod/mutations.ts) — all editing primitives. Every function:

- Takes the current `Song` and the operation parameters.
- Returns a new `Song` reference, with unchanged rows/patterns/cells reference-shared.
- **Short-circuits to the input reference** when the operation produces no observable change. This is what makes `commitEdit`'s "did anything actually change?" check cheap and reliable.
- Validates indices and returns the input unchanged for out-of-range inputs (rather than throwing) — keyboard handlers can call mutations speculatively without bounds checks.

### Cell-level

- `setCell(song, order, row, channel, patch)` — partial Note override.
- `deleteCellPullUp(song, order, row, channel)` — clear cell, pull cells below up by one row in this channel.
- `insertCellPushDown(song, order, row, channel)` — push cells in this channel down; last row falls off.

### Row-level

- `deleteRowPullUp(song, order, row)` — clear all 4 channels at row, pull rows below up.
- `insertRowPushDown(song, order, row)` — push all 4 channels down at row.

### Pattern / order-level

- `setOrderPattern(song, order, patNum)` — assign a pattern number to a slot in the order list.
- `nextPatternAtOrder(song, order)` / `prevPatternAtOrder(song, order)` — cycle through assigned patterns.
- `insertOrder(song, order)` / `deleteOrder(song, order)` — songLength changes with these.
- `newPatternAtOrder(song, order)` — allocate a fresh empty pattern and assign it.
- `duplicatePatternAtOrder(song, order)` — deep-copy current pattern as a new pattern and assign it.
- `cleanupOrders(song)` — drop unreferenced patterns, renumber the remainder densely. Returns `{ song, remap }` so callers (e.g. pattern names in [state/patternNames.ts](../src/state/patternNames.ts)) can re-key sidecar data.

### Sample-level

- `setSample(song, slot, patch)` — partial Sample override (name, finetune, volume, loop bounds, etc.).
- `clearSample(song, slot)` — reset to `emptySample()`, leaving int8 data empty.
- `replaceSampleData(song, slot, data, opts?)` — swap the int8 buffer; recomputes `lengthWords` and clamps loop bounds. Used by the sample workbench's `runPipeline` write-back.

### Range

- `transposeRange(song, range, semitones)` — shift every note period in a `PatternRange` by N semitones. Notes that land outside the period clamp `[113, 856]` are silenced (cleared). The semitone math goes through the period table so finetune is preserved.

## Pattern selections & clipboard

[src/core/mod/clipboardOps.ts](../src/core/mod/clipboardOps.ts) provides rectangular range ops:

```ts
interface PatternRange {
  order: number;
  startRow: number; endRow: number;       // inclusive
  startChannel: number; endChannel: number; // inclusive
}

readSlice(song, range): Note[][] | null;   // fresh copies — safe to clipboard
clearRange(song, range): Song;             // zero out the range, return new song
pasteSlice(song, slice, dest): Song;       // top-left at dest; clips to bounds
```

`readSlice` always copies, so the clipboard ([state/clipboard.ts](../src/state/clipboard.ts)) doesn't alias live song data. `pasteSlice` clips silently — pasting near pattern boundaries doesn't error.

## Order list flattening

[src/core/mod/flatten.ts](../src/core/mod/flatten.ts) — `flattenSong(song)` walks the order list emitting a single linear list of rows, each tagged with `{ order, row, pattern, cells }`. Used by the playhead-driven UI to compute the "next visible row" cheaply.

- Honors `Dxx` (Pattern Break) — truncates the current pattern's contribution at the break row.
- **Ignores `Bxx`** (Position Jump) — backward jumps don't loop the flattened view; the editor's grid stops at the end of the order list.
- **Caches `FlatRow` objects by cell reference.** When only one cell changes, only that row's flat entry is rebuilt; the rest are reference-stable, so Solid's `For` reconciliation can skip them.

## Sample import & selection

- [src/core/mod/sampleImport.ts](../src/core/mod/sampleImport.ts) — `importWavSample(wavBuf, slot)` decodes a WAV (8/16/24-bit int or 32-bit float, mono or stereo) via [audio/wav.ts](../src/core/audio/wav.ts), then `wavToInt8Mono` mixes to mono and quantises to int8. `deriveSampleName(filename)` strips extension and clamps to 22 chars (the .mod field width). The chiptune-aware path goes through `SampleWorkbench` instead — see [sample-pipeline.md](sample-pipeline.md).
- [src/core/mod/sampleSelection.ts](../src/core/mod/sampleSelection.ts) — `cropSample(sample, startWord, endWord)` and `cutSample(sample, startWord, endWord)` operate on word-aligned byte ranges. Loop bounds are translated when the loop survives the operation, and cleared when it doesn't.

## Why "no Pattern store"?

The `Song` is held as a single Solid signal in [state/song.ts](../src/state/song.ts). Pattern editing is currently fast enough with reference-shared mutations + signal swaps; a deeper Solid store would let the UI bind to individual cells but isn't needed yet. The mutations API was designed so that a future Pattern store can wrap it without rewriting the editor.
