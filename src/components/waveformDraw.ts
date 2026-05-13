/**
 * Shared min/max-bucket waveform rendering used by both PT's `Waveform`
 * editor and FT2's read-only `XmWaveform`. The two were drifting:
 * XmWaveform's earlier inline version lacked the polyline-mode path for
 * short samples and the previous-sample bridge in bucket mode, so short
 * or sparse-bucket samples rendered empty or gappy. Keeping this in one
 * place stops that from happening again.
 *
 * The drawing is two-mode:
 *
 * - **Polyline** (visible span ≤ canvas width): connect every sample
 *   with line segments. Adjacent samples land multiple pixels apart at
 *   high zoom, so the connecting lines are what give the eye a
 *   continuous waveform shape.
 * - **Bucket** (visible span > canvas width): per output column, find
 *   the min and max sample value in the bucket and draw a 1-px-wide
 *   vertical bar via `fillRect`. Each bar is seeded with the previous
 *   column's last sample (the "prev bridge") so columns whose bucket
 *   holds only one sample still connect to their neighbour. `fillRect`
 *   uses `Math.max(1, height)` so flat regions still draw a 1px bar
 *   instead of disappearing.
 *
 * Caller draws any overlays (selection, loop markers, playhead, etc.)
 * after this returns.
 */

export interface WaveformDrawOpts {
  /** PCM data. Sample range is [-peak, peak-1] (int8) or [-peak, peak-1] (int16). */
  data: Int8Array | Int16Array;
  /** Symmetric amplitude divisor — 128 for int8, 32768 for int16. */
  peak: number;
  /** Visible sample range start, inclusive. Default: 0. */
  start?: number;
  /** Visible sample range end, exclusive. Default: data.length. */
  end?: number;
  /** Canvas drawable size in CSS pixels. */
  width: number;
  height: number;
  /** Background fill colour. */
  bgColor: string;
  /** Centre-line colour. */
  midlineColor: string;
  /** Waveform colour (used for both stroke and fill). */
  waveColor: string;
}

export function drawSampleWaveform(
  ctx: CanvasRenderingContext2D,
  opts: WaveformDrawOpts,
): void {
  const {
    data,
    peak,
    width: w,
    height: h,
    bgColor,
    midlineColor,
    waveColor,
  } = opts;
  const start = opts.start ?? 0;
  const end = opts.end ?? data.length;

  // Background.
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // Centre line — drawn as a 1px fillRect so it lays under the wave
  // without subpixel anti-aliasing artefacts.
  ctx.fillStyle = midlineColor;
  ctx.fillRect(0, h / 2, w, 1);

  if (end <= start || data.length === 0) return;

  const sp = end - start;
  const half = h / 2;
  // `half - 1` leaves a 1px breathing room at top and bottom so peaks
  // don't clip against the canvas edge.
  const yFor = (v: number) => half - (v / peak) * (half - 1);

  ctx.fillStyle = waveColor;
  ctx.strokeStyle = waveColor;
  ctx.lineWidth = 1;

  if (sp <= w) {
    // Polyline mode — fewer samples than pixels.
    ctx.beginPath();
    const pixelSpan = Math.max(1, sp - 1);
    for (let i = 0; i < sp; i++) {
      const x = (i / pixelSpan) * (w - 1);
      const y = yFor(data[start + i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }

  // Bucket mode — more samples than pixels.
  const samplesPerPixel = sp / w;
  let prev: number | null = null;
  for (let x = 0; x < w; x++) {
    const bucketStart = start + Math.floor(x * samplesPerPixel);
    const bucketEnd = Math.min(
      end,
      start + Math.floor((x + 1) * samplesPerPixel),
    );
    if (bucketStart >= bucketEnd) continue;
    let mn = data[bucketStart]!;
    let mx = mn;
    if (prev !== null) {
      if (prev < mn) mn = prev;
      if (prev > mx) mx = prev;
    }
    for (let i = bucketStart + 1; i < bucketEnd; i++) {
      const v = data[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    prev = data[bucketEnd - 1]!;
    const yMax = yFor(mx);
    const yMin = yFor(mn);
    ctx.fillRect(
      x,
      Math.min(yMax, yMin),
      1,
      Math.max(1, Math.abs(yMax - yMin)),
    );
  }
}
