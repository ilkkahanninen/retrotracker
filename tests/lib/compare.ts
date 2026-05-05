/**
 * Sample-buffer comparison utilities for the accuracy test bed.
 *
 * Bit-exact match against pt2-clone is unrealistic (different resampling
 * filter, dithering, etc.). The test bed targets near-identity within
 * tolerances and surfaces the metrics that matter for replayer regressions.
 */

export interface CompareResult {
  /** Number of frames compared (after any length alignment). */
  frames: number;
  /** Per-channel root-mean-square of (a - b). */
  rmsDiff: number[];
  /** Per-channel peak absolute difference. */
  peakDiff: number[];
  /** Per-channel mean of |a - b|. */
  meanAbsDiff: number[];
  /** Index of the first frame where any channel exceeds `firstMismatchTolerance`. */
  firstMismatchFrame: number;
}

export interface CompareOptions {
  /** If buffers differ in length, trim the longer to the shorter. Default true. */
  trimToShortest?: boolean;
  /** Threshold used when locating the first mismatch frame. Default 1e-3. */
  firstMismatchTolerance?: number;
}

export function compareChannels(
  a: Float32Array[],
  b: Float32Array[],
  opts: CompareOptions = {},
): CompareResult {
  if (a.length !== b.length) {
    throw new Error(`Channel count mismatch: ${a.length} vs ${b.length}`);
  }
  const trim = opts.trimToShortest ?? true;
  const tol = opts.firstMismatchTolerance ?? 1e-3;

  const frames = trim
    ? Math.min(...a.map((c, i) => Math.min(c.length, b[i]!.length)))
    : (() => {
        for (let i = 0; i < a.length; i++) {
          if (a[i]!.length !== b[i]!.length) throw new Error("Length mismatch");
        }
        return a[0]?.length ?? 0;
      })();

  const rmsDiff: number[] = [];
  const peakDiff: number[] = [];
  const meanAbsDiff: number[] = [];
  let firstMismatchFrame = -1;

  for (let c = 0; c < a.length; c++) {
    let sumSq = 0;
    let sumAbs = 0;
    let peak = 0;
    const ac = a[c]!;
    const bc = b[c]!;
    for (let i = 0; i < frames; i++) {
      const d = ac[i]! - bc[i]!;
      const ad = d < 0 ? -d : d;
      sumSq += d * d;
      sumAbs += ad;
      if (ad > peak) peak = ad;
      if (firstMismatchFrame < 0 && ad > tol) firstMismatchFrame = i;
    }
    rmsDiff.push(frames === 0 ? 0 : Math.sqrt(sumSq / frames));
    peakDiff.push(peak);
    meanAbsDiff.push(frames === 0 ? 0 : sumAbs / frames);
  }

  return { frames, rmsDiff, peakDiff, meanAbsDiff, firstMismatchFrame };
}
