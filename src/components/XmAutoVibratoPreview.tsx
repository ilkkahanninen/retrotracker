import { createEffect, onCleanup, type Component } from "solid-js";

import type { XmAutoVibratoType } from "../core/xm/types";
import {
  newAutoVibratoState,
  resetAutoVibrato,
  stepAutoVibrato,
} from "../core/audio/xmAutoVibrato";

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

    // Step the same LFO the replayer runs, one tick per sample point, so
    // the curve is what will actually play: waveform direction, the
    // sweep's stepped ramp-in, and a rate of 0 all included.
    const lfo = newAutoVibratoState();
    resetAutoVibrato(lfo, depth, props.vibratoSweep);

    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    // Largest offset the LFO can produce: 64 * (15 << 8) >> 14 = 15 units.
    const FULL_SCALE = 15;
    for (let i = 0; i < TICKS; i++) {
      const x = (i / (TICKS - 1)) * cssWidth;
      const offset = stepAutoVibrato(
        lfo,
        props.vibratoType,
        depth,
        props.vibratoRate,
        false,
      );
      // The offset is in period units, where positive means lower pitch;
      // draw pitch, so up on screen is up in pitch.
      const y = cssHeight / 2 + (offset / FULL_SCALE) * (cssHeight / 2 - 4);
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
