/**
 * "Bounce a pattern selection to a sample" — render the user's selected
 * rows × channels through a Replayer that uses CleanMixer instead of Paula,
 * trim to exactly the selection's audible length, and return mono PCM that
 * `workbenchFromWavData` can wrap as a Sampler workbench.
 *
 * The render happens entirely offline (no Worklet), at a fixed high sample
 * rate so the downstream PT-target-rate resample in the Sampler pipeline
 * has plenty of headroom. Defaulting to 44.1 kHz keeps the buffer small
 * while leaving room for our sinc resampler to do its work.
 */

import type { Song } from "../mod/types";
import type { PatternSelection } from "../../state/selection";
import { CHANNELS, ROWS_PER_PATTERN, type Pattern } from "../mod/types";
import { Effect, emptyNote, emptyPattern, emptySong } from "../mod/format";
import { speedTempoAt } from "../mod/flatten";
import { Replayer } from "./replayer";
import { CleanMixer } from "./cleanMixer";
import type { WavData } from "./wav";

/** CIA timer period for `tempo` BPM, mirroring `Replayer.samplesPerTick`. */
const CIA_PAL_CLK = 709379.0;
function samplesPerTickAt(tempo: number, sampleRate: number): number {
  const ciaPeriod = Math.floor(1773447 / tempo);
  const tickHz = CIA_PAL_CLK / (ciaPeriod + 1);
  return sampleRate / tickHz;
}

/**
 * Walk the selected rows and accumulate the exact frame count their playback
 * occupies, taking per-row Fxx (speed/tempo) updates into account. This is
 * what we trim the rendered buffer to: anything past it is "tail" — samples
 * triggered during the selection that keep ringing afterwards. The user can
 * crop further in the sample editor if they want a tighter loop.
 *
 * Mirrors the replayer's row-walk behaviour for Fxx exactly: within a row,
 * channels process left-to-right and the last Fxx of each kind wins.
 */
function selectionFrameCount(
  song: Song,
  sel: PatternSelection,
  sampleRate: number,
): number {
  let { speed, tempo } = speedTempoAt(song, sel.order, sel.startRow);
  const pat = song.patterns[song.orders[sel.order] ?? 0];
  if (!pat) return 0;
  let total = 0;
  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const cells = pat.rows[r];
    if (!cells) break;
    // Apply this row's Fxx commands BEFORE counting the row's duration —
    // matches the replayer's per-row order: state update on tick 0, then
    // ticks tick at the new rate.
    for (const cell of cells) {
      if (cell.effect !== Effect.SetSpeed) continue;
      const p = cell.effectParam;
      if (p === 0) continue; // F00 = stop song; treat as a no-op for counting
      if (p < 0x20) speed = p;
      else tempo = p;
    }
    total += speed * samplesPerTickAt(tempo, sampleRate);
  }
  return Math.round(total);
}

/**
 * Build a single-pattern song that contains only the selected rows in their
 * original positions, with non-selected channels silenced. Rows outside the
 * selection are blank — the replayer plays through them but emits nothing
 * new (sample tails from selected rows still ring, which is what we want).
 *
 * Sample slots are deep-shared with the source song: the audio data is
 * read-only at playback time, so referential sharing is safe.
 */
function buildSelectionSong(song: Song, sel: PatternSelection): Song {
  const sourcePat = song.patterns[song.orders[sel.order] ?? 0];
  const out: Pattern = emptyPattern();
  if (!sourcePat) return { ...emptySong(), samples: song.samples };
  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const srcRow = sourcePat.rows[r];
    if (!srcRow) continue;
    const dstRow = out.rows[r]!;
    for (let ch = sel.startChannel; ch <= sel.endChannel; ch++) {
      const srcCell = srcRow[ch];
      if (!srcCell) continue;
      // Shallow-copy the cell — Note is a flat record of primitives.
      dstRow[ch] = { ...srcCell };
    }
    // Non-selected channels stay as the freshly-allocated empty notes from
    // emptyPattern(). We ALSO need to neutralise any Bxx / Dxx that lived
    // in unselected channels of the same row, since those would change
    // playback timing or order routing during the bounce.
    for (let ch = 0; ch < CHANNELS; ch++) {
      if (ch >= sel.startChannel && ch <= sel.endChannel) continue;
      dstRow[ch] = emptyNote();
    }
  }
  return {
    ...emptySong(),
    samples: song.samples,
    songLength: 1,
    orders: new Array(128).fill(0).map((v, i) => (i === 0 ? 0 : v)),
    patterns: [out],
  };
}

export interface BounceResult {
  /** Mono Float32 audio at `sampleRate`. */
  wav: WavData;
  /** The selection range that produced this render, for downstream metadata. */
  selection: PatternSelection;
}

export interface BounceOptions {
  /** Output sample rate — passed through to the Replayer + CleanMixer. */
  sampleRate?: number;
  /**
   * Number of trailing frames to keep after the selection's last row, so
   * sample tails still ringing don't get hard-cut. Default 0 (exact crop).
   */
  tailFrames?: number;
}

/**
 * Render the selection to a clean mono PCM buffer.
 *
 * Returns `null` for an empty / invalid selection (no rows or unknown
 * pattern). On success the buffer is mono Float32 in [-1, 1] range; the
 * caller (the App's bounce action) wraps it as a Sampler workbench via
 * `workbenchFromWavData` and lands it in the next free sample slot.
 */
export function bounceSelection(
  song: Song,
  sel: PatternSelection,
  opts: BounceOptions = {},
): BounceResult | null {
  const sampleRate = opts.sampleRate ?? 44100;
  const tailFrames = Math.max(0, opts.tailFrames ?? 0);
  if (sel.endRow < sel.startRow || sel.endChannel < sel.startChannel)
    return null;
  const numRows = sel.endRow - sel.startRow + 1;
  if (numRows <= 0 || numRows > ROWS_PER_PATTERN) return null;

  const tempSong = buildSelectionSong(song, sel);
  const exactFrames = selectionFrameCount(song, sel, sampleRate);
  if (exactFrames <= 0) return null;
  const renderFrames = exactFrames + tailFrames;

  const replayer = new Replayer(tempSong, {
    sampleRate,
    initialOrder: 0,
    // Start at row 0 of the temp song — buildSelectionSong placed the
    // selected cells at their original row indices, so we need to fast-
    // forward through the leading silent rows. Easiest: tell the replayer
    // to begin at sel.startRow.
    initialRow: sel.startRow,
    // No looping — the replayer ends naturally when it walks off the
    // single-pattern song. We render `renderFrames` first; whichever
    // limit hits first stops us.
    loop: false,
    // Replace Paula with the clean mixer — that's the whole point.
    mixerFactory: (sr) => new CleanMixer(sr),
    // Match offline-render baseline.
    stereoSeparation: 0,
  });

  const left = new Float32Array(renderFrames);
  const right = new Float32Array(renderFrames);
  const CHUNK = 1024;
  let pos = 0;
  while (pos < renderFrames && !replayer.isFinished()) {
    const want = Math.min(CHUNK, renderFrames - pos);
    replayer.process(left, right, want, pos);
    pos += want;
  }

  // Sum L/R to mono. PT-style hard pan put channels 0/3 on left and 1/2
  // on right; (L+R)/2 averages them back without losing energy.
  const mono = new Float32Array(pos);
  for (let i = 0; i < pos; i++) mono[i] = (left[i]! + right[i]!) * 0.5;

  return {
    wav: { sampleRate, channels: [mono] },
    selection: sel,
  };
}
