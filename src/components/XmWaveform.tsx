import {
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";

import type { XmSample } from "../core/xm/types";
import type { XmSampleSelection } from "../state/xmSampleSelection";
import { drawSampleWaveform } from "./waveformDraw";

/**
 * Waveform display for FT2 samples. Supports click-drag selection over
 * the sample's frame range; the selection is reported back to the
 * parent via `onSelect`. Visual overlay style and selection semantics
 * mirror PT2's `Waveform` component (frame indices into `data`, with
 * "end > start" as the live-range invariant).
 *
 * Loop markers, playhead, zoom, scrolling — all PT-only for now. The
 * pane currently only needs selection + overlay to power the FT2
 * sample-bytes clipboard's range ops.
 */
interface Props {
  sample: XmSample;
  /** Active selection in sample-frame indices, or null when none. */
  selection?: XmSampleSelection | null;
  /** Called on mouse-down + drag. `null` clears the selection. */
  onSelect?: (s: XmSampleSelection | null) => void;
  /** Set to `false` to disable mouse-drag selection (e.g. empty slot). */
  selectable?: boolean;
}

const HEIGHT = 90;

export const XmWaveform: Component<Props> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;
  const [drag, setDrag] = createSignal<{ anchorFrame: number } | null>(null);

  const dataLen = () => props.sample.data.length;

  /** Map a client X (in CSS pixels) to a frame index in the sample. */
  const frameForX = (clientX: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const x = Math.max(0, Math.min(w, clientX - rect.left));
    return Math.round((x / w) * dataLen());
  };

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

    // Selection overlay — same chrome as PT's Waveform: translucent
    // tint over the range plus 1-px edge bars on each side. Frame
    // indices map to canvas X via `x = frame * w / len`.
    const sel = props.selection;
    const len = dataLen();
    if (sel && len > 0 && sel.end > sel.start && props.selectable !== false) {
      const w = cssWidth;
      const x0 = (Math.max(0, sel.start) * w) / len;
      const x1 = (Math.min(len, sel.end) * w) / len;
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.fillRect(Math.floor(x0), 0, 1, cssHeight);
      ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, cssHeight);
    }
  };

  createEffect(() => {
    // Track sample identity + selection so any change re-renders.
    props.sample.data;
    props.sample.bits;
    props.sample.data.length;
    props.selection;
    requestAnimationFrame(draw);
  });

  const onMouseDown = (e: MouseEvent) => {
    if (props.selectable === false) return;
    if (!props.onSelect) return;
    if (dataLen() === 0) return;
    const frame = Math.max(0, Math.min(dataLen(), frameForX(e.clientX)));
    setDrag({ anchorFrame: frame });
    props.onSelect({ start: frame, end: frame });
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    const d = drag();
    if (!d || !props.onSelect) return;
    const frame = Math.max(0, Math.min(dataLen(), frameForX(e.clientX)));
    props.onSelect({
      start: Math.min(d.anchorFrame, frame),
      end: Math.max(d.anchorFrame, frame),
    });
  };

  // Window-level move/up so a drag past the canvas edge keeps tracking.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => {
      const d = drag();
      if (d && props.onSelect) {
        // A click without drag leaves start === end — interpret that as
        // "clear selection" so the user gets a way to deselect without
        // chasing a button.
        const sel = props.selection;
        if (sel && sel.start === sel.end) props.onSelect(null);
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    onCleanup(() => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    });
  });

  const onResize = () => {
    requestAnimationFrame(draw);
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    window.removeEventListener("resize", onResize);
  });

  return (
    <div
      ref={(el) => {
        container = el;
      }}
      class="xm-waveform-wrap"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    >
      <canvas
        ref={(el) => {
          canvasRef = el;
        }}
        class="xm-waveform"
        style={{ width: "100%", height: `${HEIGHT}px` }}
      />
    </div>
  );
};
