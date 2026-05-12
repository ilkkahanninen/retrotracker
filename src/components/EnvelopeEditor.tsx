import { For, Show, createMemo, createSignal, type Component } from "solid-js";

import {
  XM_MAX_ENVELOPE_POINTS,
  type XmEnvelope,
  type XmEnvelopePoint,
} from "../core/xm/types";
import { useWindowListener } from "./hooks";

/**
 * Generic XM envelope editor — a self-contained SVG widget for editing
 * the 12-point piecewise-linear envelopes XM instruments carry (one for
 * volume, one for panning). Sustain / loop indices and the on/off
 * toggles render as overlay markers and a toggle row above the canvas.
 *
 * The host passes the current envelope plus a flat set of callbacks; the
 * component owns the pointer-down → drag → patch flow but no state of
 * its own (apart from the in-flight drag identity). All mutations route
 * back through the host's `state/xmInstrumentEdit` setters so undo /
 * redo and persistence stay coherent.
 *
 * Visual conventions follow FT2's view:
 *   - X axis: tick 0 .. `maxTick` (left-to-right).
 *   - Y axis: value 0 (bottom) .. 64 (top) — same orientation for both
 *     vol and pan envelopes. For panning, value 32 is the centre line
 *     (rendered with a dashed mid-line guide).
 *   - Sustain point: dashed vertical line + ring on the point.
 *   - Loop start / end: square brackets at top of canvas.
 *   - Disabled envelope: dimmed polyline + greyed canvas background.
 */

interface EnvelopeEditorProps {
  envelope: XmEnvelope;
  kind: "volume" | "panning";
  /** Tick range the X axis spans (typical XM envelopes peak around 100). */
  maxTick?: number;
  /** Patch envelope-level flags / indices. */
  onPatchFlags: (patch: Partial<XmEnvelope>) => void;
  /** Append a point. Host enforces monotonic-tick + capacity. */
  onAddPoint: (point: XmEnvelopePoint) => void;
  /** Replace a point's coordinates (host clamps). */
  onSetPoint: (index: number, point: XmEnvelopePoint) => void;
  /** Remove a point (host preserves the 2-point minimum on its side). */
  onRemovePoint: (index: number) => void;
}

const CANVAS_W = 360;
const CANVAS_H = 120;
const POINT_RADIUS = 4;
const HIT_RADIUS = 8;
const MIN_POINTS = 2;
/**
 * Default X axis span when the envelope has no useful tail to fit
 * against (empty or single point). Most XM envelopes finish well under
 * tick 64, so this keeps the canvas usable without becoming claustrophobic
 * for the typical drag-out workflow.
 */
const DEFAULT_MAX_TICK = 64;
const VALUE_MAX = 64;

type Drag = { kind: "point"; index: number } | null;

export const EnvelopeEditor: Component<EnvelopeEditorProps> = (props) => {
  const [drag, setDrag] = createSignal<Drag>(null);
  let svgRef: SVGSVGElement | undefined;

  /**
   * Auto-fit the X axis to the data so a short envelope (e.g. last
   * point at tick 6) doesn't squeeze itself into the leftmost few
   * pixels of a wide canvas. The caller can still override by passing
   * `maxTick` explicitly. Snaps up to the next multiple of 16 so a
   * point-drag doesn't continuously rescale under the cursor — the
   * fit only changes when the rightmost tick crosses a coarse
   * boundary. Floor at 16 keeps empty / single-point envelopes from
   * collapsing to zero width.
   */
  const maxTick = () => {
    if (props.maxTick !== undefined) return props.maxTick;
    const pts = props.envelope.points;
    const last = pts.length > 0 ? pts[pts.length - 1]!.tick : 0;
    // Headroom of at least 8 ticks past the last point so the user
    // still has visual room to dbl-click a new point past the tail.
    const target = last + Math.max(8, Math.ceil(last * 0.25));
    const snapped = Math.ceil(target / 16) * 16;
    return Math.max(16, snapped);
  };
  const xForTick = (t: number) => (t / maxTick()) * CANVAS_W;
  const tickForX = (x: number) =>
    Math.round((Math.max(0, Math.min(CANVAS_W, x)) / CANVAS_W) * maxTick());
  const yForValue = (v: number) => CANVAS_H * (1 - v / VALUE_MAX);
  const valueForY = (y: number) =>
    Math.round((1 - Math.max(0, Math.min(CANVAS_H, y)) / CANVAS_H) * VALUE_MAX);

  const clientToCanvas = (clientX: number, clientY: number) => {
    if (!svgRef) return { x: 0, y: 0 };
    const rect = svgRef.getBoundingClientRect();
    // Map client coords through the SVG's viewBox.
    const sx = CANVAS_W / rect.width;
    const sy = CANVAS_H / rect.height;
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    };
  };

  const points = createMemo(() => props.envelope.points);

  const pathD = createMemo(() => {
    const pts = points();
    if (pts.length === 0) return "";
    const segs: string[] = [];
    // Extend horizontally from x=0 at the first point's value.
    const first = pts[0]!;
    segs.push(`M 0 ${yForValue(first.value)}`);
    segs.push(`L ${xForTick(first.tick)} ${yForValue(first.value)}`);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      segs.push(`L ${xForTick(p.tick)} ${yForValue(p.value)}`);
    }
    // Extend horizontally from the last point to the right edge.
    const last = pts[pts.length - 1]!;
    segs.push(`L ${CANVAS_W} ${yForValue(last.value)}`);
    return segs.join(" ");
  });

  const onPointPointerDown = (e: PointerEvent, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: "point", index });
  };

  const onPointDoubleClick = (e: MouseEvent, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (points().length <= MIN_POINTS) return;
    props.onRemovePoint(index);
  };

  const addPointAtPointer = (e: MouseEvent) => {
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const tick = tickForX(x);
    const value = valueForY(y);
    if (points().length >= XM_MAX_ENVELOPE_POINTS) return;
    // addXmEnvelopePoint inserts in the right place by tick; reject
    // only when the tick exactly matches an existing point (duplicate
    // ticks would break the monotonic invariant). Mid-envelope clicks
    // are fine.
    if (points().some((p) => p.tick === tick)) return;
    props.onAddPoint({ tick, value });
  };

  const onSvgDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    addPointAtPointer(e);
  };

  useWindowListener("pointermove", (e) => {
    const d = drag();
    if (!d) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const pts = points();
    const me = pts[d.index];
    if (!me) return;
    // Endpoint constraints: keep the leftmost point at tick 0, the
    // rightmost free. Within the middle, clamp to the neighbours so
    // the array stays sorted.
    const minTick = d.index === 0 ? 0 : pts[d.index - 1]!.tick + 1;
    const maxT =
      d.index === 0
        ? 0
        : d.index === pts.length - 1
          ? maxTick()
          : pts[d.index + 1]!.tick - 1;
    const tick = Math.max(minTick, Math.min(maxT, tickForX(x)));
    const value = Math.max(0, Math.min(VALUE_MAX, valueForY(y)));
    if (tick === me.tick && value === me.value) return;
    props.onSetPoint(d.index, { tick, value });
  });

  useWindowListener("pointerup", () => {
    if (drag()) setDrag(null);
  });

  const flag = (
    label: string,
    checked: boolean,
    onToggle: (next: boolean) => void,
  ) => (
    <label class="envelope-editor__flag">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.currentTarget.checked)}
      />
      {label}
    </label>
  );

  const updateSustainPoint = (next: number) => {
    if (next < 0 || next >= points().length) return;
    props.onPatchFlags({ sustainPoint: next });
  };

  const updateLoopBound = (which: "loopStart" | "loopEnd", next: number) => {
    if (next < 0 || next >= points().length) return;
    props.onPatchFlags({ [which]: next });
  };

  return (
    <div
      class="envelope-editor"
      data-kind={props.kind}
      classList={{ "envelope-editor--disabled": !props.envelope.enabled }}
    >
      <div class="envelope-editor__toolbar">
        {flag("On", props.envelope.enabled, (v) =>
          props.onPatchFlags({ enabled: v }),
        )}
        {flag("Sustain", props.envelope.sustainEnabled, (v) =>
          props.onPatchFlags({ sustainEnabled: v }),
        )}
        {flag("Loop", props.envelope.loopEnabled, (v) =>
          props.onPatchFlags({ loopEnabled: v }),
        )}
      </div>
      <svg
        ref={(el) => {
          svgRef = el;
        }}
        class="envelope-editor__canvas"
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.kind} envelope editor`}
        onDblClick={onSvgDoubleClick}
      >
        {/* Background. */}
        <rect
          x={0}
          y={0}
          width={CANVAS_W}
          height={CANVAS_H}
          class="envelope-editor__bg"
        />
        {/* Horizontal value guides at quarter / half / three-quarters. */}
        <For each={[0.25, 0.5, 0.75]}>
          {(t) => (
            <line
              x1={0}
              x2={CANVAS_W}
              y1={t * CANVAS_H}
              y2={t * CANVAS_H}
              class="envelope-editor__grid"
              classList={{
                "envelope-editor__grid--center":
                  props.kind === "panning" && t === 0.5,
              }}
            />
          )}
        </For>
        {/* Polyline. */}
        <path d={pathD()} class="envelope-editor__line" />
        {/* Loop bracket. */}
        <Show when={props.envelope.loopEnabled && points().length > 0}>
          {(() => {
            const loopStart = points()[props.envelope.loopStart];
            const loopEnd = points()[props.envelope.loopEnd];
            if (!loopStart || !loopEnd) return null;
            return (
              <>
                <line
                  x1={xForTick(loopStart.tick)}
                  x2={xForTick(loopStart.tick)}
                  y1={0}
                  y2={CANVAS_H}
                  class="envelope-editor__loop-bound"
                />
                <line
                  x1={xForTick(loopEnd.tick)}
                  x2={xForTick(loopEnd.tick)}
                  y1={0}
                  y2={CANVAS_H}
                  class="envelope-editor__loop-bound"
                />
              </>
            );
          })()}
        </Show>
        {/* Sustain marker. */}
        <Show when={props.envelope.sustainEnabled && points().length > 0}>
          {(() => {
            const sustain = points()[props.envelope.sustainPoint];
            if (!sustain) return null;
            return (
              <line
                x1={xForTick(sustain.tick)}
                x2={xForTick(sustain.tick)}
                y1={0}
                y2={CANVAS_H}
                class="envelope-editor__sustain"
              />
            );
          })()}
        </Show>
        {/* Points. */}
        <For each={points()}>
          {(p, i) => (
            <>
              {/* Larger invisible hit target for easier pointer grabs. */}
              <circle
                cx={xForTick(p.tick)}
                cy={yForValue(p.value)}
                r={HIT_RADIUS}
                class="envelope-editor__point-hit"
                onPointerDown={(e) => onPointPointerDown(e, i())}
                onDblClick={(e) => onPointDoubleClick(e, i())}
              />
              <circle
                cx={xForTick(p.tick)}
                cy={yForValue(p.value)}
                r={POINT_RADIUS}
                class="envelope-editor__point"
                classList={{
                  "envelope-editor__point--sustain":
                    props.envelope.sustainEnabled &&
                    props.envelope.sustainPoint === i(),
                  "envelope-editor__point--loop":
                    props.envelope.loopEnabled &&
                    (props.envelope.loopStart === i() ||
                      props.envelope.loopEnd === i()),
                }}
              />
            </>
          )}
        </For>
      </svg>
      <div class="envelope-editor__indices">
        <label>
          Sustain
          <select
            value={props.envelope.sustainPoint}
            disabled={
              !props.envelope.sustainEnabled || points().length < MIN_POINTS
            }
            onChange={(e) => updateSustainPoint(Number(e.currentTarget.value))}
          >
            <For each={points()}>
              {(_p, i) => <option value={i()}>{i() + 1}</option>}
            </For>
          </select>
        </label>
        <label>
          Loop start
          <select
            value={props.envelope.loopStart}
            disabled={
              !props.envelope.loopEnabled || points().length < MIN_POINTS
            }
            onChange={(e) =>
              updateLoopBound("loopStart", Number(e.currentTarget.value))
            }
          >
            <For each={points()}>
              {(_p, i) => <option value={i()}>{i() + 1}</option>}
            </For>
          </select>
        </label>
        <label>
          Loop end
          <select
            value={props.envelope.loopEnd}
            disabled={
              !props.envelope.loopEnabled || points().length < MIN_POINTS
            }
            onChange={(e) =>
              updateLoopBound("loopEnd", Number(e.currentTarget.value))
            }
          >
            <For each={points()}>
              {(_p, i) => <option value={i()}>{i() + 1}</option>}
            </For>
          </select>
        </label>
      </div>
    </div>
  );
};
