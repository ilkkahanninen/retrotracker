import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";

import type { XmSample } from "../core/xm/types";
import type { XmSampleSelection } from "../state/xmSampleSelection";
import type { EnvelopePoint, ParamAxis } from "../core/audio/sampleWorkbench";
import { drawSampleWaveform } from "./waveformDraw";
import { EnvelopeOverlay } from "./EnvelopeOverlay";

/**
 * On-canvas envelope overlay payload for XM samples. Same shape as
 * PT2's `WaveformEnvelopeOverlay` but the X domain is frames (XM's
 * sample buffer is frame-indexed regardless of bit depth).
 */
export interface XmWaveformEnvelopeOverlay {
  points: ReadonlyArray<EnvelopePoint>;
  axis: ParamAxis;
  /** Total frames in the envelope's input stage (chain output up to —
   *  but not including — the active effect). */
  sourceFrames: number;
  /** Sample buffer length in frames; used to scale envelope frames into
   *  canvas X coords against the rendered waveform. */
  sampleFrames: number;
  onAddPoint: (point: EnvelopePoint) => void;
  onRemovePoint: (pointIndex: number) => void;
  onPatchPoint: (pointIndex: number, next: Partial<EnvelopePoint>) => void;
  onNudgeSegment: (leftPointIndex: number, deltaValue: number) => void;
}

interface Props {
  sample: XmSample;
  /** Active selection in sample-frame indices, or null when none. */
  selection?: XmSampleSelection | null;
  /** Called on mouse-down + drag. `null` clears the selection. */
  onSelect?: (s: XmSampleSelection | null) => void;
  /** Set to `false` to disable mouse-drag selection (e.g. empty slot). */
  selectable?: boolean;
  /** Patch the sample's mutable fields. Used by the on-canvas loop-marker
   *  drag to update `loopStart` / `loopLength`. */
  onPatch?: (patch: Partial<XmSample>) => void;
  /** When non-null, render an editable envelope curve on top of the
   *  waveform (e.g. for a `volume` effect from the chain). The host
   *  (InstrumentView) gates this on the user having selected a chain
   *  entry with an envelope param. */
  envelope?: XmWaveformEnvelopeOverlay | null;
}

/** Canvas-internal width — drawing target before DPR / CSS scaling. */
const W = 1024;
/** Canvas-internal height — matches `.xm-waveform` height in CSS. */
const H = 90;
/** Pointer must be within this many canvas-internal pixels of a loop
 *  boundary line to grab it. */
const HANDLE_HIT_PX = 8;

type DragState =
  | { kind: "loop"; which: "start" | "end" }
  | { kind: "select"; anchorFrame: number };

export const XmWaveform: Component<Props> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;

  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [hover, setHover] = createSignal<"start" | "end" | null>(null);

  const dataLen = () => props.sample.data.length;
  const loopActive = () =>
    props.sample.loopType !== "none" && props.sample.loopLength > 0;

  /** Map a canvas-internal x (0..W) to a sample frame. */
  const frameForCanvasX = (x: number): number => {
    const len = dataLen();
    if (len === 0) return 0;
    return Math.round((x / W) * len);
  };

  /** Map a sample frame to canvas-internal x. */
  const xForFrame = (frame: number): number => {
    const len = dataLen();
    if (len === 0) return 0;
    return (frame * W) / len;
  };

  /** Map a client X (CSS pixels) to a canvas-internal x. */
  const clientToCanvasX = (clientX: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  };

  /** Map a client Y (CSS pixels) to a canvas-internal y. Used by the
   *  envelope overlay to translate pointer Y into a value. */
  const clientToCanvasY = (clientY: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return ((clientY - rect.top) / rect.height) * H;
  };

  /** Envelope-stage frame index → canvas X. Scales by the
   *  envelope-source-frames vs sample-frames ratio so the curve aligns
   *  with the rendered waveform even if a length-changing effect (crop /
   *  cut) sits upstream. */
  const xForEnvelopeFrame = (frame: number): number => {
    const env = props.envelope;
    if (!env || env.sourceFrames <= 0 || env.sampleFrames <= 0) {
      return xForFrame(frame);
    }
    const sampleFrame = (frame * env.sampleFrames) / env.sourceFrames;
    return xForFrame(sampleFrame);
  };

  /** Inverse — canvas X → envelope-stage frame. */
  const envelopeFrameForX = (x: number): number => {
    const env = props.envelope;
    if (!env || env.sampleFrames <= 0 || env.sourceFrames <= 0) {
      return frameForCanvasX(x);
    }
    const sampleFrame = frameForCanvasX(x);
    return Math.round((sampleFrame * env.sourceFrames) / env.sampleFrames);
  };

  /** Which loop boundary is the pointer near, or null. The host passes
   *  `onPatch` only when loop editing should be enabled (chiptune mode
   *  omits it because the synth re-applies a full-cycle loop on every
   *  render) — without `onPatch` we skip hit-testing so the cursor never
   *  hints at a grabbable handle. */
  const handleAt = (x: number): "start" | "end" | null => {
    if (!props.onPatch) return null;
    if (!loopActive() || dataLen() === 0) return null;
    const s = props.sample;
    const xs = xForFrame(s.loopStart);
    const xe = xForFrame(s.loopStart + s.loopLength);
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? "start" : "end";
  };

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
    drawSampleWaveform(ctx, {
      data: props.sample.data,
      peak: props.sample.bits === 16 ? 32768 : 128,
      width: cssWidth,
      height: cssHeight,
      bgColor: cs.getPropertyValue("--panel-2").trim() || "#1c1e26",
      midlineColor: cs.getPropertyValue("--grid-line").trim() || "#33363f",
      waveColor: "#5ec9ff",
    });

    // The selection + loop overlays draw against CSS-pixel coordinates so
    // we need a fresh frame→x scaler that uses cssWidth, not W.
    const cssXForFrame = (f: number): number =>
      dataLen() === 0 ? 0 : (f * cssWidth) / dataLen();

    // Loop overlay — translucent band + 1-px edge bars, matching PT2.
    if (loopActive() && dataLen() > 0) {
      const s = props.sample;
      const x0 = cssXForFrame(s.loopStart);
      const x1 = cssXForFrame(s.loopStart + s.loopLength);
      ctx.fillStyle = "rgba(94, 200, 255, 0.18)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
      ctx.fillStyle = "#5ec8ff";
      ctx.fillRect(Math.floor(x0), 0, 1, cssHeight);
      ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, cssHeight);
    }

    // Selection overlay.
    const sel = props.selection;
    const len = dataLen();
    if (sel && len > 0 && sel.end > sel.start && props.selectable !== false) {
      const x0 = cssXForFrame(Math.max(0, sel.start));
      const x1 = cssXForFrame(Math.min(len, sel.end));
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.fillRect(Math.floor(x0), 0, 1, cssHeight);
      ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, cssHeight);
    }
  };

  createEffect(() => {
    // Track inputs that affect the canvas paint.
    props.sample.data;
    props.sample.bits;
    props.sample.loopStart;
    props.sample.loopLength;
    props.sample.loopType;
    props.selection;
    requestAnimationFrame(draw);
  });

  const onMouseDown = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const handle = handleAt(x);
    if (handle && props.onPatch) {
      setDrag({ kind: "loop", which: handle });
      e.preventDefault();
      return;
    }
    if (props.selectable === false) return;
    if (!props.onSelect) return;
    if (dataLen() === 0) return;
    const frame = Math.max(0, Math.min(dataLen(), frameForCanvasX(x)));
    setDrag({ kind: "select", anchorFrame: frame });
    props.onSelect({ start: frame, end: frame });
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const d = drag();
    if (!d) {
      setHover(handleAt(x));
      return;
    }
    const s = props.sample;
    const len = dataLen();
    if (d.kind === "loop" && props.onPatch) {
      const frame = Math.max(0, Math.min(len, frameForCanvasX(x)));
      if (d.which === "start") {
        const endFrame = s.loopStart + s.loopLength;
        const newStart = Math.max(0, Math.min(frame, endFrame - 1));
        props.onPatch({
          loopStart: newStart,
          loopLength: endFrame - newStart,
        });
      } else {
        const newEnd = Math.max(s.loopStart + 1, Math.min(frame, len));
        props.onPatch({ loopLength: newEnd - s.loopStart });
      }
    } else if (d.kind === "select" && props.onSelect) {
      const frame = Math.max(0, Math.min(len, frameForCanvasX(x)));
      props.onSelect({
        start: Math.min(d.anchorFrame, frame),
        end: Math.max(d.anchorFrame, frame),
      });
    }
  };

  const onMouseLeave = () => {
    if (!drag()) setHover(null);
  };

  // Window-level move/up so a drag past the canvas edge keeps tracking.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => {
      const d = drag();
      if (d?.kind === "select" && props.onSelect) {
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

  const onResize = () => requestAnimationFrame(draw);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  return (
    <div
      ref={(el) => {
        container = el;
      }}
      class="xm-waveform-wrap"
      classList={{
        "xm-waveform-wrap--grab": hover() !== null && !drag(),
        "xm-waveform-wrap--grabbing": drag()?.kind === "loop",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <canvas
        ref={(el) => {
          canvasRef = el;
        }}
        class="xm-waveform"
        style={{ width: "100%", height: `${H}px` }}
      />
      <Show when={props.envelope}>
        {(env) => (
          <EnvelopeOverlay
            points={env().points}
            axis={env().axis}
            sourceFrames={env().sourceFrames}
            width={W}
            height={H}
            xForFrame={xForEnvelopeFrame}
            frameForX={envelopeFrameForX}
            clientToCanvasX={clientToCanvasX}
            clientToCanvasY={clientToCanvasY}
            onAddPoint={env().onAddPoint}
            onRemovePoint={env().onRemovePoint}
            onPatchPoint={env().onPatchPoint}
            onNudgeSegment={env().onNudgeSegment}
          />
        )}
      </Show>
    </div>
  );
};
