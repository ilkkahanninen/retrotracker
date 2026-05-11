import { createEffect, onCleanup, type Component } from "solid-js";

import type { XmSample } from "../core/xm/types";
import { drawSampleWaveform } from "./waveformDraw";

/**
 * Read-only waveform display for FT2 samples. Draws into a canvas at
 * device-pixel-ratio resolution so the line stays crisp on hi-DPI
 * displays. Designed to sit inside `InstrumentView` — no selection,
 * cropping, or workbench coupling (the PT-side `Waveform` carries all
 * of that; Phase 4 only needs visual verification of the imported
 * sample).
 *
 * Min/max bucketing + polyline fallback for short samples lives in the
 * shared `drawSampleWaveform` helper so PT and FT2 can't diverge again.
 */
interface Props {
  sample: XmSample;
}

const HEIGHT = 90;

export const XmWaveform: Component<Props> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight || HEIGHT;
    if (cssWidth === 0) return;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cs = getComputedStyle(canvas);
    drawSampleWaveform(ctx, {
      data: props.sample.data,
      peak: props.sample.bits === 16 ? 32768 : 128,
      width: cssWidth,
      height: cssHeight,
      bgColor: cs.getPropertyValue("--panel-2").trim() || "#1c1e26",
      midlineColor: cs.getPropertyValue("--grid-line").trim() || "#33363f",
      waveColor: "#5ec9ff",
    });
  };

  createEffect(() => {
    // Track sample identity + length so a different sample triggers a
    // redraw without depending on referential equality of `data`.
    props.sample.data;
    props.sample.bits;
    props.sample.data.length;
    requestAnimationFrame(draw);
  });

  // Redraw on resize so the bucket math always matches the visible
  // canvas width.
  const onResize = () => {
    requestAnimationFrame(draw);
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    window.removeEventListener("resize", onResize);
  });

  return (
    <canvas
      ref={(el) => {
        canvasRef = el;
      }}
      class="xm-waveform"
      style={{ width: "100%", height: `${HEIGHT}px` }}
    />
  );
};
