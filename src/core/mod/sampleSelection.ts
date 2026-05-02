import type { Sample } from './types';

/**
 * Pure helpers that take a Sample and a byte-range selection and return the
 * new data + loop fields (in word units, ready to hand to replaceSampleData).
 *
 * Word alignment: PT samples are word-aligned (lengthWords, loopStartWords,
 * loopLengthWords). When the user drags a selection in byte space we round
 * the boundaries inward — start UP, end DOWN — so we never land on an odd
 * byte boundary that PT can't represent.
 *
 * Loop handling: replaceSampleData clamps the loop further if it would still
 * overrun the new length, so we don't have to be perfectly precise here.
 */

export interface CropMeta {
  data: Int8Array;
  loopStartWords: number;
  loopLengthWords: number;
}

/** Word-align the selection inward (start up, end down). */
function alignSelection(sample: Sample, startByte: number, endByte: number): { start: number; end: number } | null {
  const len = sample.data.byteLength;
  const start = Math.max(0, Math.min(len, (startByte + 1) & ~1));
  const end   = Math.max(start, Math.min(len, endByte & ~1));
  if (end - start < 2) return null;
  return { start, end };
}

/**
 * Crop: keep `data[start..end)`. Loop is translated to the new origin and
 * clamped/cleared if it spills past the new bounds.
 */
export function cropSample(sample: Sample, startByte: number, endByte: number): CropMeta | null {
  const aligned = alignSelection(sample, startByte, endByte);
  if (!aligned) return null;
  const { start, end } = aligned;
  const newData = sample.data.slice(start, end);

  const wasLooped   = sample.loopLengthWords > 1;
  const oldLoopByte = sample.loopStartWords * 2;
  const oldLoopEnd  = oldLoopByte + sample.loopLengthWords * 2;
  const newLoopStart = Math.max(0, oldLoopByte - start) >> 1;
  const newLoopEnd   = Math.max(newLoopStart * 2, Math.min(newData.byteLength, oldLoopEnd - start)) >> 1;
  const newLoopLen   = newLoopEnd - newLoopStart;
  const keep = wasLooped && newLoopLen >= 2;

  return {
    data: newData,
    loopStartWords:  keep ? newLoopStart : 0,
    loopLengthWords: keep ? newLoopLen   : 1,
  };
}

/**
 * Cut: keep everything OUTSIDE `[start, end)` — i.e. `data[0..start) ++
 * data[end..len)`. The loop survives only if it sat entirely on one side of
 * the cut: a cut that intersects the loop body has no faithful translation,
 * so we drop the loop in that case.
 */
export function cutSample(sample: Sample, startByte: number, endByte: number): CropMeta | null {
  const aligned = alignSelection(sample, startByte, endByte);
  if (!aligned) return null;
  const { start, end } = aligned;
  const before = sample.data.subarray(0, start);
  const after  = sample.data.subarray(end);
  const newData = new Int8Array(before.byteLength + after.byteLength);
  newData.set(before, 0);
  newData.set(after, before.byteLength);

  const cutBytes    = end - start;
  const wasLooped   = sample.loopLengthWords > 1;
  const oldLoopByte = sample.loopStartWords * 2;
  const oldLoopEnd  = oldLoopByte + sample.loopLengthWords * 2;
  let loopStartWords  = sample.loopStartWords;
  let loopLengthWords = sample.loopLengthWords;
  let keep = wasLooped;
  if (oldLoopEnd <= start) {
    // Loop entirely before the cut — unchanged.
  } else if (oldLoopByte >= end) {
    // Loop entirely after the cut — shift left by the cut size.
    loopStartWords = (oldLoopByte - cutBytes) >> 1;
  } else if (wasLooped) {
    // Loop overlaps the cut region — no clean way to keep it.
    keep = false;
  }

  return {
    data: newData,
    loopStartWords:  keep ? loopStartWords  : 0,
    loopLengthWords: keep ? loopLengthWords : 1,
  };
}
