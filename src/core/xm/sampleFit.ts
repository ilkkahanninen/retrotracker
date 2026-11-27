/**
 * Pure helpers for the FT2 sample pipeline's length fit: what rate a
 * sample will be played at, and what happens to its loop when the
 * pipeline output changes length.
 */

import type { XmRenderTarget } from "../audio/sampleWorkbench";
import { xmC4Rate } from "../audio/xmFreqTable";
import type { XmLoopType, XmSample } from "./types";

/**
 * Render target for a sample with this tuning: the rate the replayer
 * reads it at on a C-4 trigger. Null when the tuning puts C-4 outside
 * FT2's playable range — there is no rate to fit against, so the
 * pipeline leaves the length alone.
 */
export function xmRenderTargetFor(
  tuning: Pick<XmSample, "relativeNote" | "finetune">,
  linearFreq: boolean,
): XmRenderTarget | null {
  const c4Rate = xmC4Rate(tuning.relativeNote, tuning.finetune, linearFreq);
  return c4Rate === null ? null : { c4Rate };
}

export interface XmLoopFields {
  loopStart: number;
  loopLength: number;
  loopType: XmLoopType;
}

/**
 * Loop bounds for a sample whose data went from `oldLen` to `newLen`
 * frames.
 *
 * - `"clamp"` keeps the frame positions and trims what no longer fits.
 *   Right for chain / source edits: a crop or a new WAV is different
 *   audio, and the old positions are the best guess there is.
 * - `"scale"` moves both ends proportionally. Right when the same audio
 *   was only resampled (a length fit, a resampler change, a retune under
 *   a fit): the loop should still cover the same sound. The end is
 *   scaled as an end, not as a length, so a loop that reached the last
 *   frame still does.
 *
 * A loop squeezed to nothing is switched off.
 */
export function refitXmLoop(
  loop: XmLoopFields,
  oldLen: number,
  newLen: number,
  mode: "clamp" | "scale",
): XmLoopFields {
  const ratio = mode === "scale" && oldLen > 0 ? newLen / oldLen : 1;
  const oldEnd = loop.loopStart + loop.loopLength;
  const loopStart = Math.max(
    0,
    Math.min(newLen, Math.round(loop.loopStart * ratio)),
  );
  const loopEnd = Math.max(
    loopStart,
    Math.min(newLen, Math.round(oldEnd * ratio)),
  );
  const loopLength = loopEnd - loopStart;
  return {
    loopStart,
    loopLength,
    loopType: loopLength > 0 ? loop.loopType : "none",
  };
}
