import { createEffect, createSignal, type Accessor } from "solid-js";

/**
 * Zoomable viewport over a sample buffer, shared by PT's `Waveform` and
 * FT2's `XmWaveform`. Owns the visible index range `[start, end)` and the
 * index ↔ canvas-X mapping, and turns wheel gestures into zoom / pan:
 *
 *   - mouse wheel:        zoom in / out, anchored at the pointer
 *   - shift + wheel:      horizontal pan
 *   - trackpad two-finger horizontal swipe: horizontal pan
 *
 * The view resets to the whole buffer whenever the data *reference*
 * changes (slot switch, a pipeline edit that re-renders the sample, a
 * song load) so the user is never left looking at a stale region. Edits
 * that keep the same buffer — dragging a loop handle, a volume tweak —
 * build a new sample object around the same data and leave the zoom
 * alone.
 *
 * Indices are bytes for PT and frames for FT2; the maths is the same.
 * Create it inside a component: it registers a reactive effect.
 */
export interface WaveformViewport {
  /** First visible index, inclusive. */
  start: Accessor<number>;
  /** Last visible index, exclusive. */
  end: Accessor<number>;
  /** True when the view shows less than the whole buffer. */
  zoomed: () => boolean;
  /** Index → canvas X. Indices outside the view land below 0 or past
   *  `width`; callers clip. */
  xFor: (index: number) => number;
  /** Inverse of `xFor` for an X inside the canvas. */
  indexForX: (x: number) => number;
  /** Back to the whole buffer. */
  reset: () => void;
  /** Zoom or pan for a wheel event whose pointer sits at canvas X `x`.
   *  Calls `preventDefault` so the page doesn't scroll underneath. */
  wheel: (e: WheelEvent, x: number) => void;
}

/** Hard floor on the visible span — closer than this and the polyline
 *  stops meaning anything. */
const MIN_VIEW_SPAN = 8;

/**
 * Wheel-zoom sensitivity. Multiplied by `e.deltaY` to get the log-zoom
 * step, then exp'd: zoomFactor = exp(deltaY · sensitivity). Tuned so a
 * single mouse-wheel "click" (deltaY ≈ 100) zooms by ~× 1.65, while a
 * trackpad two-finger scroll (deltaY ≈ 4–10 per event, fired ~60×/sec)
 * accumulates smoothly to a similar magnitude over the user's gesture
 * without snapping. Bigger value = faster zoom.
 */
const ZOOM_SENSITIVITY = 0.015;

/**
 * @param data  the buffer on show; only its identity and length are read.
 * @param width canvas width the X coordinates are expressed in.
 */
export function createWaveformViewport(
  data: () => { readonly length: number },
  width: number,
): WaveformViewport {
  const [start, setStart] = createSignal(0);
  const [end, setEnd] = createSignal(0);

  const len = () => data().length;
  const span = () => Math.max(1, end() - start());

  let lastSeen: unknown = null;
  createEffect(() => {
    const d = data();
    if (d === lastSeen) return;
    lastSeen = d;
    setStart(0);
    setEnd(d.length);
  });

  // Mirrors `drawSampleWaveform`: at or below one index per pixel it
  // draws a polyline whose last point sits on the last pixel column.
  const xFor = (index: number): number => {
    const sp = span();
    if (sp <= width) {
      const pixelSpan = Math.max(1, sp - 1);
      return ((index - start()) / pixelSpan) * (width - 1);
    }
    return ((index - start()) * width) / sp;
  };

  const indexForX = (x: number): number => {
    const sp = span();
    if (sp <= width) {
      const pixelSpan = Math.max(1, sp - 1);
      return start() + Math.round((x / Math.max(1, width - 1)) * pixelSpan);
    }
    return start() + Math.round((x * sp) / width);
  };

  const reset = () => {
    setStart(0);
    setEnd(len());
  };

  /** Pan by `amount` indices, clamped to the buffer. */
  const panBy = (amount: number) => {
    const total = len();
    // High-zoom trackpad case: a single event might ask for less than
    // one index of pan, which would round to zero and strand the user.
    // Snap any requested motion up to one index in its direction.
    let dist = amount;
    if (dist !== 0 && Math.abs(dist) < 1) dist = Math.sign(dist);
    const sp = span();
    let s = start() + dist;
    let e = s + sp;
    if (s < 0) {
      s = 0;
      e = sp;
    }
    if (e > total) {
      e = total;
      s = Math.max(0, total - sp);
    }
    setStart(Math.round(s));
    setEnd(Math.round(e));
  };

  const wheel = (e: WheelEvent, x: number) => {
    const total = len();
    if (total === 0) return;
    e.preventDefault();

    const sp = span();

    // Trackpad two-finger swipes report deltaX; mouse wheel + shift maps
    // vertical scroll onto horizontal — both go through the same pan
    // path. Pan by `delta_pixels · (span / width)` so one trackpad pixel
    // maps to one canvas pixel of pan at any zoom level.
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      panBy(dx * (sp / width));
      return;
    }

    // Zoom anchored at the pointer — keep the index under it at the same
    // canvas X across the step. Same gesture as Logic / Audacity. The
    // factor scales by `exp(deltaY · sensitivity)` so trackpad gestures
    // accumulate gracefully while a mouse-wheel click is a clear step.
    const t = Math.max(0, Math.min(1, x / width));
    const anchor = start() + t * sp;

    const factor = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
    const newSp = Math.max(
      Math.min(MIN_VIEW_SPAN, total),
      Math.min(total, sp * factor),
    );

    let s = anchor - t * newSp;
    let en = s + newSp;
    if (s < 0) {
      s = 0;
      en = newSp;
    }
    if (en > total) {
      en = total;
      s = Math.max(0, total - newSp);
    }
    setStart(Math.floor(s));
    setEnd(Math.ceil(en));
  };

  return {
    start,
    end,
    zoomed: () => start() > 0 || end() < len(),
    xFor,
    indexForX,
    reset,
    wheel,
  };
}
