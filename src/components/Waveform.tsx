import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { useWindowListener } from "./hooks";
import type { Sample } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { previewFrame } from "../state/preview";
import type { SampleSelection } from "../state/sampleSelection";
import { beginDragEdit, endDragEdit } from "../state/song";
import { EnvelopeOverlay } from "./EnvelopeOverlay";
import type { EnvelopePoint, ParamAxis } from "../core/audio/sampleWorkbench";
import { drawSampleWaveform } from "./waveformDraw";

export type { SampleSelection };

/**
 * Per-slot envelope-overlay payload. The chain stage's frame indices
 * differ from int8-byte indices when a length-changing effect (crop /
 * cut) sits before the envelope, so we accept frames here and convert
 * to bytes via `chainFramesToBytes` before drawing.
 */
export interface WaveformEnvelopeOverlay {
  points: ReadonlyArray<EnvelopePoint>;
  /** Per-param domain (range, log/linear, color). Drives the overlay's
   *  Y-axis mapping and curve color so the same component can edit
   *  volume / cutoff / Q / shaper drive without per-param branches. */
  axis: ParamAxis;
  /** Total frames in the envelope's input stage. */
  sourceFrames: number;
  /** Length of the int8 sample data the waveform shows. Used to scale
   *  envelope frames into byte coordinates. */
  int8Length: number;
  onAddPoint: (point: EnvelopePoint) => void;
  onRemovePoint: (pointIndex: number) => void;
  onPatchPoint: (pointIndex: number, next: Partial<EnvelopePoint>) => void;
  onNudgeSegment: (leftPointIndex: number, deltaValue: number) => void;
}

/**
 * Min/max-bucketed PCM rendering with a zoomable byte-range viewport.
 *
 * Two stacked canvases: the bottom one is the waveform (repainted only when
 * `props.sample` or the viewport changes), the top one is a transparent
 * overlay that holds just the playhead (repainted on every `previewFrame`
 * tick). Splitting the layers keeps the heavy bucket loop out of the 60 Hz
 * update path and side-steps the "redraw the whole wave to move the cursor"
 * problem.
 *
 * Zoom controls (no UI chrome — gesture-only):
 *   - mouse wheel:        zoom in / out, anchored at the cursor
 *   - shift + wheel:      horizontal pan
 *   - trackpad two-finger horizontal swipe: horizontal pan
 *   - double-click:       reset to full sample
 *
 * The viewport state lives inside this component and resets whenever the
 * sample's data reference changes (slot switch, pipeline edit that changes
 * length, `.mod` load, …) — those should never leave the user staring at a
 * stale region of the previous sample.
 */
export interface WaveformProps {
  sample: Sample;
  onPatch: (patch: Partial<Sample>) => void;
  selection: SampleSelection | null;
  onSelect: (s: SampleSelection | null) => void;
  /** When false, hide the loop overlay and ignore loop-handle drag. */
  showLoop: boolean;
  /**
   * When false, drag-to-select is disabled and the selection overlay is
   * not drawn. Used in chiptune mode where the synth re-renders the cycle
   * on every param change, so any user-drawn range would be wiped on the
   * next edit (and there's no Crop / Cut / range-aware effect button to
   * act on it anyway). Defaults to true for callers that haven't opted in.
   */
  selectable?: boolean;
  /**
   * When non-null, render an editable envelope overlay on top of the
   * waveform (e.g. for editing a `volume` effect). The host (SampleView)
   * gates this on the user having selected a `volume` effect in the
   * pipeline editor; passing `null` hides the overlay.
   */
  envelope?: WaveformEnvelopeOverlay | null;
}

/** Either dragging a loop boundary, or sweeping a selection range. */
type DragState =
  | { kind: "loop"; which: "start" | "end" }
  | { kind: "select"; anchorByte: number };

const W = 1024;
// Canvas internal height — kept in sync with --waveform-height (the box
// it's drawn into). The canvas is upscaled via CSS, so a mismatch would
// just produce a blurry waveform, not a layout break.
const H = 160;
/** Pointer must be within this many canvas-internal pixels of a loop line to grab it. */
const HANDLE_HIT_PX = 8;
/** Hard floor on viewport span — closer than this and the polyline becomes meaningless. */
const MIN_VIEW_BYTES = 8;
/**
 * Wheel-zoom sensitivity. Multiplied by `e.deltaY` to get the log-zoom
 * step, then exp'd: zoomFactor = exp(deltaY · sensitivity). Tuned so a
 * single mouse-wheel "click" (deltaY ≈ 100) zooms by ~× 1.65, while a
 * trackpad two-finger scroll (deltaY ≈ 4–10 per event, fired ~60×/sec)
 * accumulates smoothly to a similar magnitude over the user's gesture
 * without snapping. Bigger value = faster zoom.
 */
const ZOOM_SENSITIVITY = 0.015;

export const Waveform: Component<WaveformProps> = (props) => {
  let waveCanvas: HTMLCanvasElement | undefined;
  let playheadCanvas: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;

  /** Active drag, if any. */
  const [drag, setDrag] = createSignal<DragState | null>(null);
  /** Hover over a handle (drives cursor) — independent of drag because we
   *  also want the cursor while the user is grabbing. */
  const [hover, setHover] = createSignal<"start" | "end" | null>(null);
  /**
   * Pointer-anchored cursor tooltip showing the byte under the cursor and
   * the equivalent `9xx` (Set Sample Offset) effect parameter. Updated on
   * mouse move and cleared on mouse leave (unless a drag is in flight, so
   * the readout stays useful while sweeping a selection or dragging a loop
   * handle past the canvas edge). `flipLeft` toggles when the pointer is
   * close to the right edge so the tooltip flips to the cursor's left side
   * instead of clipping out of the .waveform overflow:hidden box.
   */
  const [cursorInfo, setCursorInfo] = createSignal<{
    byte: number;
    x: number;
    y: number;
    flipLeft: boolean;
  } | null>(null);

  /** Approximate tooltip width in CSS pixels — used by the edge-flip math. */
  const TOOLTIP_FLIP_PX = 130;
  /** Pixel offset between the cursor and the tooltip. Keeps the readout
   *  visible without sitting directly under the pointer. */
  const TOOLTIP_OFFSET_PX = 12;

  const updateCursorInfo = (e: MouseEvent) => {
    if (!container || dataLen() === 0) {
      setCursorInfo(null);
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) {
      setCursorInfo(null);
      return;
    }
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const x = clientToCanvasX(e.clientX);
    const byte = Math.max(0, Math.min(dataLen() - 1, byteForX(x)));
    setCursorInfo({
      byte,
      x: localX,
      y: localY,
      flipLeft: localX > rect.width - TOOLTIP_FLIP_PX,
    });
  };

  /** `9xx` (SetSampleOffset) parameter that points closest to `byte`. PT's
   *  param is byte-step 256, capped at 0xFF — anything past byte 65280 just
   *  saturates to 9FF (the highest byte the effect can address in one go). */
  const sampleOffsetParam = (byte: number): string => {
    const v = Math.min(0xff, byte >> 8);
    return `9${v.toString(16).toUpperCase().padStart(2, "0")}`;
  };

  // Viewport in BYTES — `[viewStart, viewEnd)` is what gets drawn. Defaults
  // to the whole sample on every data swap (see effect below).
  const [viewStart, setViewStart] = createSignal(0);
  const [viewEnd, setViewEnd] = createSignal(0);

  const dataLen = () => props.sample.data.length;
  const viewSpan = () => Math.max(1, viewEnd() - viewStart());

  // Reset zoom only when the underlying Int8Array reference actually changes.
  // The effect fires on every `props.sample` swap (loop-handle drag, volume
  // tweak, etc. all build a fresh Sample object), but those don't change
  // `data` — so without the ref check the user's zoom would snap back the
  // moment they touched a handle, which was the reported bug.
  let lastSeenData: Int8Array | null = null;
  createEffect(() => {
    const data = props.sample.data;
    if (data === lastSeenData) return;
    lastSeenData = data;
    setViewStart(0);
    setViewEnd(data.length);
  });

  /** Map a byte index to a canvas X in the current view. Bytes outside
   *  `[viewStart, viewEnd)` may return values < 0 or > W; callers clip. */
  const xForByte = (byte: number): number => {
    const sp = viewSpan();
    if (sp <= W) {
      const pixelSpan = Math.max(1, sp - 1);
      return ((byte - viewStart()) / pixelSpan) * (W - 1);
    }
    return ((byte - viewStart()) * W) / sp;
  };

  /** Inverse of xForByte — clamped to [viewStart, viewEnd]. */
  const byteForX = (x: number): number => {
    const sp = viewSpan();
    if (sp <= W) {
      const pixelSpan = Math.max(1, sp - 1);
      return viewStart() + Math.round((x / Math.max(1, W - 1)) * pixelSpan);
    }
    return viewStart() + Math.round((x * sp) / W);
  };

  /** Convert a clientX from a mouse event to canvas-internal x (0..W). */
  const clientToCanvasX = (clientX: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  };

  /** Same for clientY → canvas-internal y (0..H). Used by the envelope
   *  overlay to convert pointer Y to gain via its own mapping. */
  const clientToCanvasY = (clientY: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return ((clientY - rect.top) / rect.height) * H;
  };

  /** Envelope point's chain-stage frame index → canvas-internal X.
   *  Frames map onto bytes by the int8/source-frames ratio (the same
   *  scaling `selectionToChainFrames` uses, inverted). */
  const xForEnvelopeFrame = (frame: number): number => {
    const env = props.envelope;
    if (!env || env.sourceFrames <= 0) return xForByte(frame);
    const byte = (frame * env.int8Length) / env.sourceFrames;
    return xForByte(byte);
  };

  /** Inverse — canvas X → envelope-stage frame index. */
  const envelopeFrameForX = (x: number): number => {
    const env = props.envelope;
    if (!env || env.int8Length <= 0) return byteForX(x);
    const byte = byteForX(x);
    return Math.round((byte * env.sourceFrames) / env.int8Length);
  };

  /** Mouse-x near a loop boundary? Returns which one, or null. */
  const handleAt = (x: number): "start" | "end" | null => {
    const s = props.sample;
    if (!props.showLoop) return null;
    if (s.loopLengthWords <= 1) return null;
    if (dataLen() === 0) return null;
    const xs = xForByte(s.loopStartWords * 2);
    const xe = xForByte((s.loopStartWords + s.loopLengthWords) * 2);
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? "start" : "end";
  };

  const onMouseDown = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const handle = handleAt(x);
    if (handle) {
      // Coalesce every loop-handle commit fired during this drag into a
      // single undo entry — the matching `endDragEdit` runs in the window-
      // level mouseup handler below.
      beginDragEdit();
      setDrag({ kind: "loop", which: handle });
      e.preventDefault();
      return;
    }
    if (dataLen() === 0) return;
    if (props.selectable === false) return;
    const byte = Math.max(0, Math.min(dataLen(), byteForX(x)));
    setDrag({ kind: "select", anchorByte: byte });
    props.onSelect({ start: byte, end: byte });
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    updateCursorInfo(e);
    const d = drag();
    if (!d) {
      setHover(handleAt(x));
      return;
    }
    const s = props.sample;
    const len = dataLen();
    if (d.kind === "loop") {
      // Clamp to sample bounds and round to a word boundary (PT's loop fields
      // are word-aligned).
      const word = Math.max(
        0,
        Math.min(s.lengthWords, Math.round(byteForX(x) / 2)),
      );
      if (d.which === "start") {
        const endWord = s.loopStartWords + s.loopLengthWords;
        const newStart = Math.max(0, Math.min(word, endWord - 2));
        props.onPatch({
          loopStartWords: newStart,
          loopLengthWords: endWord - newStart,
        });
      } else {
        const newEnd = Math.max(
          s.loopStartWords + 2,
          Math.min(word, s.lengthWords),
        );
        props.onPatch({ loopLengthWords: newEnd - s.loopStartWords });
      }
    } else {
      const byte = Math.max(0, Math.min(len, byteForX(x)));
      props.onSelect({
        start: Math.min(d.anchorByte, byte),
        end: Math.max(d.anchorByte, byte),
      });
    }
  };

  const onMouseLeave = () => {
    if (!drag()) {
      setHover(null);
      setCursorInfo(null);
    }
  };

  // Window-level move/up while dragging, so the user can drag past the canvas
  // edge without losing the grab. Cleaned up the moment the drag ends.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => {
      const d = drag();
      if (d?.kind === "select") {
        const sel = props.selection;
        if (sel && sel.start === sel.end) props.onSelect(null);
      }
      if (d?.kind === "loop") endDragEdit();
      setDrag(null);
    };
    useWindowListener("mousemove", move);
    useWindowListener("mouseup", up);
  });

  // If the component unmounts mid-drag (view switch, sample slot change,
  // …), Solid disposes the createEffect above and removes the window
  // listeners — but `endDragEdit` would never run, leaving the module-level
  // `dragSnapshot` stuck and silently swallowing every subsequent commit's
  // undo entry. Close the open drag group on disposal as a backstop.
  onCleanup(() => {
    if (drag()?.kind === "loop") endDragEdit();
  });

  /** Pan the viewport by `bytes`, clamped to the sample. */
  const panBy = (bytes: number) => {
    const len = dataLen();
    if (len === 0) return;
    // High-zoom trackpad case: a single event might want < 1 byte of pan,
    // which would round to zero and the user can't move at all. Snap any
    // requested motion up to ≥ 1 byte in the requested direction.
    let dist = bytes;
    if (dist !== 0 && Math.abs(dist) < 1) dist = Math.sign(dist);
    const sp = viewSpan();
    let s = viewStart() + dist;
    let e = s + sp;
    if (s < 0) {
      s = 0;
      e = sp;
    }
    if (e > len) {
      e = len;
      s = Math.max(0, len - sp);
    }
    setViewStart(Math.round(s));
    setViewEnd(Math.round(e));
  };

  const onWheel = (e: WheelEvent) => {
    const len = dataLen();
    if (len === 0) return;
    e.preventDefault();

    const sp = viewSpan();

    // Trackpad two-finger swipes report deltaX; mouse wheel + shift maps
    // vertical scroll onto horizontal — both go through the same pan path.
    // Pan by `delta_pixels · (span / W)` so one trackpad pixel maps to one
    // canvas pixel of pan — feels natural at any zoom level.
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      panBy(dx * (sp / W));
      return;
    }

    // Zoom anchored at the cursor — keep the byte under the pointer at the
    // same canvas-x across the zoom step. Same gesture as Logic / Audacity.
    // Factor scales by `exp(deltaY · sensitivity)` so each scroll pixel
    // produces a tiny, smooth zoom — trackpad gestures (deltaY ≈ 4–10 per
    // event, ~60 Hz) accumulate gracefully, mouse wheel clicks
    // (deltaY ≈ 100 per click) still produce a clearly-felt step.
    const x = clientToCanvasX(e.clientX);
    const t = Math.max(0, Math.min(1, x / W));
    const anchorByte = viewStart() + t * sp;

    const factor = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
    let newSp = sp * factor;
    newSp = Math.max(MIN_VIEW_BYTES, Math.min(len, newSp));

    let s = anchorByte - t * newSp;
    let en = s + newSp;
    if (s < 0) {
      s = 0;
      en = newSp;
    }
    if (en > len) {
      en = len;
      s = Math.max(0, len - newSp);
    }
    setViewStart(Math.floor(s));
    setViewEnd(Math.ceil(en));
  };

  /** Reset to full-sample view. */
  const onDoubleClick = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    // Don't reset when the user double-clicks a loop handle — that's a drag
    // gesture, not a zoom-out gesture.
    if (handleAt(x)) return;
    setViewStart(0);
    setViewEnd(dataLen());
    e.preventDefault();
  };

  // Waveform layer: redrawn whenever the sample buffer or the viewport changes.
  createEffect(() => {
    const c = waveCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const data = props.sample.data;
    const start = viewStart();
    const end = Math.min(data.length, viewEnd());

    drawSampleWaveform(ctx, {
      data,
      peak: 128,
      start,
      end,
      width: W,
      height: H,
      bgColor: "#1c1e26",
      midlineColor: "#2a2d38",
      waveColor: "#5ec8ff",
    });

    if (data.byteLength === 0) return;

    if (props.showLoop) drawLoopOverlay(ctx, props.sample, W, H, xForByte);

    // Zoom indicator: a thin bar at the bottom showing where the viewport
    // sits inside the full sample. Only shown when actually zoomed in.
    if (start > 0 || end < data.length) {
      drawZoomIndicator(ctx, W, H, start, end, data.length);
    }
  });

  // Playhead layer: redrawn on every previewFrame tick. The whole canvas is
  // cleared first because we don't keep track of the previous cursor x —
  // clearing 1024×160 transparent pixels is cheaper than diff-painting.
  createEffect(() => {
    const c = playheadCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const len = props.sample.data.length;
    const start = viewStart();
    const end = viewEnd();

    // Selection overlay, clipped to the viewport. Skipped when the host
    // disabled selection (e.g. chiptune source) — without this guard a
    // stale selection from a prior source kind would still paint.
    const sel = props.selection;
    if (sel && len > 0 && sel.end > sel.start && props.selectable !== false) {
      const sStart = Math.max(start, sel.start);
      const sEnd = Math.min(end, sel.end);
      if (sEnd > sStart) {
        const x0 = xForByte(sStart);
        const x1 = xForByte(sEnd);
        ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
        // Edge lines only drawn if the original selection edge is inside
        // the view, so a clipped-off edge doesn't read as the real boundary.
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        if (sel.start >= start && sel.start < end)
          ctx.fillRect(Math.floor(x0), 0, 1, H);
        if (sel.end >= start && sel.end <= end)
          ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, H);
      }
    }

    const pf = previewFrame();
    if (!pf || pf.slot !== currentSample() - 1) return;
    if (len === 0) return;
    if (pf.frame < start || pf.frame >= end) return;
    const x = xForByte(pf.frame);
    ctx.fillStyle = "#ff7a59";
    ctx.fillRect(Math.floor(x), 0, 1, H);
  });

  return (
    <div
      class="waveform"
      ref={(el) => (container = el)}
      classList={{
        "waveform--grab": hover() !== null && !drag(),
        "waveform--grabbing": drag()?.kind === "loop",
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDblClick={onDoubleClick}
      title="Scroll to zoom · Shift+scroll to pan · Double-click to reset"
    >
      <canvas
        class="waveform__layer"
        ref={(el) => (waveCanvas = el)}
        width={W}
        height={H}
      />
      <canvas
        class="waveform__layer waveform__playhead"
        ref={(el) => (playheadCanvas = el)}
        width={W}
        height={H}
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
      <Show when={cursorInfo()}>
        {(info) => (
          <div
            class="waveform__cursor-info"
            // Pin to the pointer with a small offset; flip to the cursor's
            // left side near the right edge so the readout doesn't get
            // clipped by the .waveform overflow:hidden box.
            style={{
              left: `${
                info().flipLeft
                  ? info().x - TOOLTIP_OFFSET_PX
                  : info().x + TOOLTIP_OFFSET_PX
              }px`,
              top: `${info().y + TOOLTIP_OFFSET_PX}px`,
              transform: info().flipLeft ? "translateX(-100%)" : "",
            }}
          >
            <span>Frame: {info().byte}</span>
            <span>(cmd: {sampleOffsetParam(info().byte)})</span>
          </div>
        )}
      </Show>
    </div>
  );
};

function drawLoopOverlay(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  w: number,
  h: number,
  xForByte: (b: number) => number,
): void {
  const loopStart = sample.loopStartWords * 2;
  const loopLen = sample.loopLengthWords * 2;
  if (loopLen <= 2 || sample.data.length <= 0) return;
  const x0 = xForByte(loopStart);
  const x1 = xForByte(loopStart + loopLen);
  // Clip the band to the visible canvas; if both edges are off-screen on
  // the same side, skip drawing.
  const cx0 = Math.max(0, Math.min(w, x0));
  const cx1 = Math.max(0, Math.min(w, x1));
  if (cx1 <= cx0) return;
  ctx.fillStyle = "rgba(94, 200, 255, 0.18)";
  ctx.fillRect(cx0, 0, Math.max(1, cx1 - cx0), h);
  ctx.fillStyle = "#5ec8ff";
  // Only draw the boundary line if the original boundary is on-screen —
  // otherwise we'd be marking the canvas edge as the loop boundary.
  if (x0 >= 0 && x0 <= w) ctx.fillRect(x0, 0, 1, h);
  if (x1 >= 0 && x1 <= w) ctx.fillRect(Math.max(0, x1 - 1), 0, 1, h);
}

/**
 * Tiny zoom-extent bar at the bottom of the canvas. Shows what fraction of
 * the sample is currently in view and where, so the user always knows how
 * far they've zoomed in even though there's no surrounding chrome.
 */
function drawZoomIndicator(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  viewStart: number,
  viewEnd: number,
  total: number,
): void {
  const barH = 3;
  const y = h - barH - 2;
  // Track.
  ctx.fillStyle = "rgba(94, 200, 255, 0.12)";
  ctx.fillRect(0, y, w, barH);
  // Thumb.
  const x0 = Math.max(0, (viewStart / total) * w);
  const x1 = Math.min(w, (viewEnd / total) * w);
  ctx.fillStyle = "rgba(94, 200, 255, 0.7)";
  ctx.fillRect(x0, y, Math.max(2, x1 - x0), barH);
}
