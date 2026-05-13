/**
 * "Bounce a pattern selection to an instrument" — FT2 sibling of
 * `core/audio/bounce.ts`. Renders the user's selected rows × channels
 * through an `XmReplayer`, trims to exactly the selection's audible
 * length, and returns mono PCM that the caller can wrap as a Sampler
 * workbench / new instrument.
 *
 * Unlike the PT side there's no CleanMixer to swap in — the XM mixer
 * doesn't go through a Paula filter, so its raw output is already clean
 * for bounce purposes.
 */

import { speedTempoAtXm } from "../xm/flatten";
import { emptyXmNote, emptyXmPattern, emptyXmSong } from "../xm/format";
import { XM_MAX_ORDERS, type XmPattern, type XmSong } from "../xm/types";
import type { PatternSelection } from "../../state/selection";
import { XmReplayer } from "./xmReplayer";
import type { WavData } from "./wav";

/** Ft2-clone derives tempo via `Hz = (BPM * 2 / 5)`; mirrors XmReplayer's `samplesPerTick`. */
function samplesPerTickAt(tempo: number, sampleRate: number): number {
  const tickHz = (tempo * 2) / 5;
  return sampleRate / tickHz;
}

/**
 * Walk the selected rows and accumulate the exact frame count their
 * playback occupies, taking per-row Fxx (speed/tempo) updates into
 * account. Mirrors `selectionFrameCount` on the PT side; the XM
 * replayer's tempo math is `Hz = BPM * 2 / 5` rather than PT's CIA
 * formula.
 */
function selectionFrameCount(
  song: XmSong,
  sel: PatternSelection,
  sampleRate: number,
): number {
  let { speed, tempo } = speedTempoAtXm(song, sel.order, sel.startRow);
  const patIdx = song.orders[sel.order];
  if (patIdx === undefined) return 0;
  const pat = song.patterns[patIdx];
  if (!pat) return 0;
  let total = 0;
  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const cells = pat.rows[r];
    if (!cells) break;
    for (const cell of cells) {
      if (cell.effect !== 0x0f) continue;
      const p = cell.effectParam;
      if (p === 0) continue; // F00 = stop song
      if (p < 32) speed = p;
      else tempo = p;
    }
    total += speed * samplesPerTickAt(tempo, sampleRate);
  }
  return Math.round(total);
}

/**
 * Build a single-pattern song that contains only the selected rows ×
 * channels, with everything else blanked. Sample data is shared by
 * reference — read-only at playback time. Mirrors `buildSelectionSong`
 * on the PT side but uses XM's wider channel count and variable pattern
 * row count.
 */
function buildSelectionSong(song: XmSong, sel: PatternSelection): XmSong {
  const srcPatIdx = song.orders[sel.order];
  if (srcPatIdx === undefined) {
    const empty = emptyXmSong();
    return { ...empty, instruments: song.instruments };
  }
  const srcPat = song.patterns[srcPatIdx];
  if (!srcPat) {
    const empty = emptyXmSong();
    return { ...empty, instruments: song.instruments };
  }
  const channelCount = song.channelCount;
  const rowCount = srcPat.rowCount;
  const out: XmPattern = emptyXmPattern(rowCount, channelCount);
  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const srcRow = srcPat.rows[r];
    if (!srcRow) continue;
    const dstRow = out.rows[r]!;
    for (let ch = sel.startChannel; ch <= sel.endChannel; ch++) {
      const srcCell = srcRow[ch];
      if (!srcCell) continue;
      dstRow[ch] = { ...srcCell };
    }
    // Neutralise Bxx / Dxx in non-selected channels so they don't
    // hijack timing during the bounce.
    for (let ch = 0; ch < channelCount; ch++) {
      if (ch >= sel.startChannel && ch <= sel.endChannel) continue;
      dstRow[ch] = emptyXmNote();
    }
  }
  const orders = new Array(XM_MAX_ORDERS).fill(0);
  return {
    ...emptyXmSong(),
    title: song.title,
    channelCount,
    instruments: song.instruments,
    songLength: 1,
    orders,
    patterns: [out],
    flags: song.flags,
    defaultTempo: song.defaultTempo,
    defaultBpm: song.defaultBpm,
  };
}

export interface XmBounceResult {
  /** Mono Float32 audio at `sampleRate`. */
  wav: WavData;
  /** The selection that produced this render. */
  selection: PatternSelection;
}

export interface XmBounceOptions {
  sampleRate?: number;
  tailFrames?: number;
}

/**
 * Render the selection to a clean mono PCM buffer. Returns `null` for
 * an empty / invalid selection. Mirrors `bounceSelection` on the PT
 * side: caller wraps the result as a Sampler workbench and lands it in
 * a fresh instrument slot.
 */
export function bounceXmSelection(
  song: XmSong,
  sel: PatternSelection,
  opts: XmBounceOptions = {},
): XmBounceResult | null {
  const sampleRate = opts.sampleRate ?? 44100;
  const tailFrames = Math.max(0, opts.tailFrames ?? 0);
  if (sel.endRow < sel.startRow || sel.endChannel < sel.startChannel)
    return null;
  if (sel.endChannel >= song.channelCount) return null;

  const tempSong = buildSelectionSong(song, sel);
  const exactFrames = selectionFrameCount(song, sel, sampleRate);
  if (exactFrames <= 0) return null;
  const renderFrames = exactFrames + tailFrames;

  const replayer = new XmReplayer(tempSong, {
    sampleRate,
    initialOrder: 0,
    initialRow: sel.startRow,
    loop: false,
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

  // Sum L/R to mono — XM's panning sits anywhere across the stereo
  // field per voice, so averaging is the conservative choice.
  const mono = new Float32Array(pos);
  for (let i = 0; i < pos; i++) mono[i] = (left[i]! + right[i]!) * 0.5;

  return {
    wav: { sampleRate, channels: [mono] },
    selection: sel,
  };
}
