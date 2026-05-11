import { createEffect, onCleanup, type Component } from "solid-js";

import type { XmSample } from "../core/xm/types";

/**
 * Read-only waveform display for FT2 samples. Draws into a canvas at
 * device-pixel-ratio resolution so the line stays crisp on hi-DPI
 * displays. Designed to sit inside `InstrumentView` — no selection,
 * cropping, or workbench coupling (the PT-side `Waveform` carries all
 * of that; Phase 4 only needs visual verification of the imported
 * sample). Handles both 8-bit and 16-bit data uniformly via a peak
 * normalised to the type's max amplitude.
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

    // Background.
    ctx.fillStyle =
      getComputedStyle(canvas).getPropertyValue("--panel-2").trim() ||
      "#1c1e26";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Midline.
    ctx.strokeStyle =
      getComputedStyle(canvas).getPropertyValue("--grid-line").trim() ||
      "#33363f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssHeight / 2);
    ctx.lineTo(cssWidth, cssHeight / 2);
    ctx.stroke();

    const data = props.sample.data;
    if (data.length === 0) return;
    const peak = props.sample.bits === 16 ? 32768 : 128;
    const half = cssHeight / 2;
    // Bucket the samples per output column and draw the (min, max)
    // pair as a vertical line. Mirrors PT2 Waveform.tsx's
    // bucket strategy so dense samples don't moiré.
    const samplesPerPx = Math.max(1, data.length / cssWidth);
    ctx.strokeStyle = "#5ec9ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < cssWidth; x++) {
      const startIdx = Math.floor(x * samplesPerPx);
      const endIdx = Math.min(
        data.length,
        Math.max(startIdx + 1, Math.floor((x + 1) * samplesPerPx)),
      );
      let min = data[startIdx] ?? 0;
      let max = min;
      for (let i = startIdx + 1; i < endIdx; i++) {
        const v = data[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMin = half - (max / peak) * half;
      const yMax = half - (min / peak) * half;
      ctx.moveTo(x + 0.5, yMin);
      ctx.lineTo(x + 0.5, yMax);
    }
    ctx.stroke();
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
