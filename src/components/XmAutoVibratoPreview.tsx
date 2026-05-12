import { createEffect, onCleanup, type Component } from "solid-js";

import type { XmAutoVibratoType } from "../core/xm/types";

interface Props {
  vibratoType: XmAutoVibratoType;
  /** 0..255 — number of ticks the depth ramps from 0 to full. */
  vibratoSweep: number;
  /** 0..15 — peak depth (in semitones × 64ths). */
  vibratoDepth: number;
  /** 0..63 — frequency. FT2's autovibrato rate is roughly
   *  `(rate / 256) * 2π` radians per tick. */
  vibratoRate: number;
}

/** Width of the preview canvas in internal coordinates. */
const W = 260;
const H = 38;
/** Ticks of synthetic playback the preview renders — about 1.5 sec at
 *  the default tempo. Long enough that even slow sweeps and slow rates
 *  are visible. */
const TICKS = 200;

/**
 * Tiny canvas showing what the instrument's autovibrato modulation
 * looks like over ~1.5 seconds. The shape is computed from the four
 * autovibrato params (waveform, sweep, depth, rate) the same way the
 * XM replayer does — see [src/core/audio/xmReplayer.ts]. Useful as a
 * visual sanity check so the user can dial in a setting without having
 * to start playback.
 */
export const XmAutoVibratoPreview: Component<Props> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight || H;
    if (cssWidth === 0) return;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cs = getComputedStyle(canvas);
    const bg = cs.getPropertyValue("--panel-2").trim() || "#1c1e26";
    const mid = cs.getPropertyValue("--grid-line").trim() || "#33363f";
    const fg = cs.getPropertyValue("--accent").trim() || "#5ec9ff";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Midline.
    ctx.fillStyle = mid;
    ctx.fillRect(0, cssHeight / 2, cssWidth, 1);

    const depth = props.vibratoDepth;
    if (depth === 0) {
      // Render a flat midline + faded label so it's clear the
      // preview is intentionally silent.
      return;
    }

    // Sweep is the number of ticks the depth ramps from 0 → full.
    // sweep=0 means no ramp (instant full depth).
    const sweep = props.vibratoSweep;
    // Rate translates to radians per tick. The exact factor matches
    // FT2's `phase += rate` with 256 = full cycle.
    const radPerTick = (props.vibratoRate / 256) * Math.PI * 2;

    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    for (let i = 0; i < TICKS; i++) {
      const x = (i / (TICKS - 1)) * cssWidth;
      // Linear ramp from 0..1 over `sweep` ticks; saturates at 1 after.
      const ramp = sweep > 0 ? Math.min(1, i / sweep) : 1;
      // Phase in radians at this tick.
      const phase = i * radPerTick;
      let shape: number;
      switch (props.vibratoType) {
        case "sine":
          shape = Math.sin(phase);
          break;
        case "square":
          shape = Math.sin(phase) >= 0 ? 1 : -1;
          break;
        case "ramp-down":
          // Falling sawtooth: +1 → -1 across a cycle.
          shape = 1 - 2 * ((phase / (Math.PI * 2)) % 1);
          break;
        case "ramp-up":
          shape = 2 * ((phase / (Math.PI * 2)) % 1) - 1;
          break;
      }
      // depth 0..15 covers ~half the canvas height at full ramp.
      const amplitude = (depth / 15) * (cssHeight / 2 - 4) * ramp;
      const y = cssHeight / 2 - shape * amplitude;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  createEffect(() => {
    // Track inputs that affect the canvas paint.
    props.vibratoType;
    props.vibratoSweep;
    props.vibratoDepth;
    props.vibratoRate;
    requestAnimationFrame(draw);
  });

  const onResize = () => requestAnimationFrame(draw);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  return (
    <canvas
      ref={(el) => {
        canvasRef = el;
      }}
      class="xm-autovibrato-preview"
      style={{ width: "100%", height: `${H}px` }}
      aria-label="Autovibrato shape preview"
      width={W}
      height={H}
    />
  );
};
