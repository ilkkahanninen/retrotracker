import { For, createEffect, createSignal, type Component } from "solid-js";
import { useWindowListener } from "./hooks";
import {
  ENVELOPE_MIN_POINTS,
  type EnvelopePoint,
  type ParamAxis,
} from "../core/audio/sampleWorkbench";

/**
 * SVG overlay for editing a piecewise-linear envelope on top of the
 * waveform canvas. Points sit at chain-stage frames with the param's
 * value on the Y axis. The host (Waveform.tsx) supplies coordinate
 * helpers parameterised on its viewport so a zoomed-in waveform shows
 * the same zoom on the envelope.
 *
 * Generic over which param the envelope drives — volume / cutoff / Q /
 * shaper drive — via the `axis` prop. The axis defines:
 *   - value range (min / max)
 *   - linear vs logarithmic Y mapping (cutoff is log; the rest are linear)
 *   - the curve color (set on the SVG root as `--envelope-color`).
 *
 * Interactions:
 *   - Pointer-down on a point + drag → moves it (host clamps frame to
 *     valid neighbour bounds and value to the axis range). Endpoint-
 *     frame drag is ignored — endpoints stay pinned to 0 / lastFrame.
 *   - Pointer-down on a segment line + drag (vertical) → both endpoints
 *     of the segment move in value by the same delta.
 *   - Double-click on a point → remove (no-op when only 2 remain).
 *   - Double-click on the SVG background or a segment line → add a new
 *     point at the click position.
 */
export interface EnvelopeOverlayProps {
  points: ReadonlyArray<EnvelopePoint>;
  /** Per-param domain: value range, log/linear, color. */
  axis: ParamAxis;
  /** Total frames in the envelope's input stage — caps the rightmost point's frame. */
  sourceFrames: number;
  /** Internal canvas width / height (the SVG fills the same coord space). */
  width: number;
  height: number;
  /** Frame index → canvas-internal X. Already accounts for viewport zoom. */
  xForFrame: (frame: number) => number;
  /** Inverse of xForFrame, clamped to viewport bounds. */
  frameForX: (x: number) => number;
  /** Pointer's clientX → canvas-internal X. */
  clientToCanvasX: (clientX: number) => number;
  /** Pointer's clientY → canvas-internal Y. */
  clientToCanvasY: (clientY: number) => number;
  onAddPoint: (point: EnvelopePoint) => void;
  onRemovePoint: (pointIndex: number) => void;
  onPatchPoint: (pointIndex: number, next: Partial<EnvelopePoint>) => void;
  onNudgeSegment: (leftPointIndex: number, deltaValue: number) => void;
}

/**
 * Y-axis mapping. `y=0` is the top of the canvas, `y=H` is the bottom.
 * Linear axes split the range evenly; log axes spread it across decades
 * so cutoff sweeps don't bunch up the bottom octaves.
 */
function yForValue(v: number, axis: ParamAxis, H: number): number {
  if (axis.logarithmic) {
    const lo = Math.log(axis.min);
    const hi = Math.log(axis.max);
    const lv = Math.log(Math.max(axis.min, Math.min(axis.max, v)));
    return H * (1 - (lv - lo) / (hi - lo));
  }
  return H * (1 - (v - axis.min) / (axis.max - axis.min));
}

function valueForY(y: number, axis: ParamAxis, H: number): number {
  const t = Math.max(0, Math.min(1, 1 - y / H));
  if (axis.logarithmic) {
    return Math.exp(
      Math.log(axis.min) + t * (Math.log(axis.max) - Math.log(axis.min)),
    );
  }
  return axis.min + t * (axis.max - axis.min);
}

type Drag =
  | { kind: "point"; index: number }
  | {
      kind: "segment";
      leftIndex: number;
      startValue: number;
      lastDelta: number;
    };

export const EnvelopeOverlay: Component<EnvelopeOverlayProps> = (props) => {
  // Sort points by frame for rendering — the host normalises on commit
  // but a mid-drag set may still have an out-of-order tail, and we want
  // the polyline to draw left-to-right regardless.
  const sortedPoints = () =>
    [...props.points].sort((a, b) => a.frame - b.frame);

  const [drag, setDrag] = createSignal<Drag | null>(null);

  // Polyline path string — runs through every point, plus virtual horizontal
  // extensions at the endpoints to visualise the clamp-to-boundary semantics.
  const pathD = () => {
    const pts = sortedPoints();
    if (pts.length === 0) return "";
    const W = props.width;
    const H = props.height;
    const segs: string[] = [];
    // Clamp-left: extend horizontally from x=0 at the first point's value.
    const first = pts[0]!;
    const xFirst = props.xForFrame(first.frame);
    segs.push(`M 0 ${yForValue(first.value, props.axis, H)}`);
    segs.push(`L ${xFirst} ${yForValue(first.value, props.axis, H)}`);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      segs.push(
        `L ${props.xForFrame(p.frame)} ${yForValue(p.value, props.axis, H)}`,
      );
    }
    // Clamp-right: extend horizontally from the last point to x=W.
    const last = pts[pts.length - 1]!;
    segs.push(`L ${W} ${yForValue(last.value, props.axis, H)}`);
    return segs.join(" ");
  };

  const onPointPointerDown = (e: PointerEvent, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({ kind: "point", index });
  };

  const onPointDoubleClick = (e: MouseEvent, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (props.points.length <= ENVELOPE_MIN_POINTS) return;
    props.onRemovePoint(index);
  };

  const onSegmentPointerDown = (e: PointerEvent, leftIndex: number) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({
      kind: "segment",
      leftIndex,
      startValue: valueForY(
        props.clientToCanvasY(e.clientY),
        props.axis,
        props.height,
      ),
      lastDelta: 0,
    });
  };

  const onSegmentDoubleClick = (e: MouseEvent) => {
    // SVG dblclick still fires on the segment line — add a point there.
    e.stopPropagation();
    e.preventDefault();
    addPointAtPointer(e);
  };

  const onSvgDoubleClick = (e: MouseEvent) => {
    // Dblclick on background — same as on segment.
    addPointAtPointer(e);
  };

  const addPointAtPointer = (e: MouseEvent) => {
    const x = props.clientToCanvasX(e.clientX);
    const y = props.clientToCanvasY(e.clientY);
    const frame = Math.max(
      0,
      Math.min(Math.max(0, props.sourceFrames - 1), props.frameForX(x)),
    );
    props.onAddPoint({ frame, value: valueForY(y, props.axis, props.height) });
  };

  // Window-level move/up while dragging. Using window listeners (not local
  // SVG handlers) so the user can drag past the SVG edge without losing
  // the grab. Same pattern as Waveform's loop / selection drag.
  createEffect(() => {
    const d = drag();
    if (!d) return;
    const move = (e: PointerEvent) => {
      const x = props.clientToCanvasX(e.clientX);
      const y = props.clientToCanvasY(e.clientY);
      if (d.kind === "point") {
        const frame = Math.max(
          0,
          Math.min(
            Math.max(0, props.sourceFrames - 1),
            Math.round(props.frameForX(x)),
          ),
        );
        const value = valueForY(y, props.axis, props.height);
        // Endpoints stay pinned to 0 / lastFrame — let the user adjust
        // value only. Mid-points get full freedom; the state action
        // sorts/dedupes if dragged past a neighbour.
        const lastIndex = props.points.length - 1;
        const isEndpoint = d.index === 0 || d.index === lastIndex;
        if (isEndpoint) {
          props.onPatchPoint(d.index, { value });
        } else {
          props.onPatchPoint(d.index, { frame, value });
        }
      } else if (d.kind === "segment") {
        const curV = valueForY(y, props.axis, props.height);
        const delta = curV - d.startValue;
        // Apply only the *incremental* delta since the last move so the
        // segment-nudge action accumulates correctly across multiple
        // pointermoves (each call adds its delta to the current values).
        const incremental = delta - d.lastDelta;
        if (incremental !== 0) {
          props.onNudgeSegment(d.leftIndex, incremental);
          setDrag({ ...d, lastDelta: delta });
        }
      }
    };
    const up = () => setDrag(null);
    useWindowListener("pointermove", move);
    useWindowListener("pointerup", up);
    useWindowListener("pointercancel", up);
  });

  return (
    <svg
      class="waveform__envelope"
      // Internal coord space matches the canvases so xForFrame returns
      // values directly usable as SVG x. Stretches with the .waveform
      // container via preserveAspectRatio="none". The axis color flows
      // through CSS custom property so .envelope__path /
      // .envelope__point can stay generic.
      style={{ "--envelope-color": props.axis.color }}
      viewBox={`0 0 ${props.width} ${props.height}`}
      preserveAspectRatio="none"
      onDblClick={onSvgDoubleClick}
    >
      {/* Polyline path — the visible envelope curve. Pointer-events: none
          so segment-drag uses the dedicated transparent <line> hit areas
          underneath instead of this stroked path (no thick capture region). */}
      <path d={pathD()} class="envelope__path" />

      {/* Transparent capture lines per segment. Wide stroke so the user
          doesn't have to be pixel-precise. Visual rendering happens via
          the path above. */}
      <For each={sortedPoints().slice(0, -1)}>
        {(_p, i) => {
          const a = () => sortedPoints()[i()]!;
          const b = () => sortedPoints()[i() + 1]!;
          return (
            <line
              class="envelope__segment"
              x1={props.xForFrame(a().frame)}
              y1={yForValue(a().value, props.axis, props.height)}
              x2={props.xForFrame(b().frame)}
              y2={yForValue(b().value, props.axis, props.height)}
              onPointerDown={(e) => onSegmentPointerDown(e, i())}
              onDblClick={onSegmentDoubleClick}
            />
          );
        }}
      </For>

      {/* Points. Rendered after segments so they sit on top of the hit
          areas — drag-on-point wins over drag-on-segment when the
          pointer overlaps both. */}
      <For each={sortedPoints()}>
        {(p, i) => (
          <circle
            class="envelope__point"
            classList={{
              "envelope__point--dragging": (() => {
                const d = drag();
                return d?.kind === "point" && d.index === i();
              })(),
            }}
            cx={props.xForFrame(p.frame)}
            cy={yForValue(p.value, props.axis, props.height)}
            r={5}
            onPointerDown={(e) => onPointPointerDown(e, i())}
            onDblClick={(e) => onPointDoubleClick(e, i())}
          />
        )}
      </For>
    </svg>
  );
};
