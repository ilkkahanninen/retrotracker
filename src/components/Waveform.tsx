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
import {
  drawLoopBand,
  drawSampleWaveform,
  drawZoomIndicator,
} from "./waveformDraw";
import { createWaveformViewport } from "./waveformViewport";
import {
  waveformCursorInfoAt,
  type WaveformCursorInfo,
} from "./sampleEditorShared";
import { WaveformCursorReadout } from "./WaveformCursorReadout";

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
 * Zoom controls (no UI chrome — gesture-only): wheel to zoom, shift+wheel
 * or a horizontal swipe to pan (see `createWaveformViewport`, shared with
 * the FT2 waveform), double-click to reset to the full sample.
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
   * Pointer-anchored readout: the byte under the pointer and the `9xx`
   * command that points there (see `WaveformCursorReadout`). Updated on
   * mouse move and cleared on mouse leave — unless a drag is in flight,
   * so it stays useful while sweeping a selection or dragging a loop
   * handle past the canvas edge.
   */
  const [cursorInfo, setCursorInfo] = createSignal<WaveformCursorInfo | null>(
    null,
  );

  const updateCursorInfo = (e: MouseEvent) => {
    if (!container || dataLen() === 0) {
      setCursorInfo(null);
      return;
    }
    const x = clientToCanvasX(e.clientX);
    const byte = Math.max(0, Math.min(dataLen() - 1, byteForX(x)));
    setCursorInfo(waveformCursorInfoAt(e, container, byte));
  };

  // Viewport in BYTES — `[vp.start, vp.end)` is what gets drawn.
  const dataLen = () => props.sample.data.length;
  const vp = createWaveformViewport(() => props.sample.data, W);
  const xForByte = vp.xFor;
  const byteForX = vp.indexForX;

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

  const onWheel = (e: WheelEvent) => vp.wheel(e, clientToCanvasX(e.clientX));

  /** Reset to full-sample view. */
  const onDoubleClick = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    // Don't reset when the user double-clicks a loop handle — that's a drag
    // gesture, not a zoom-out gesture.
    if (handleAt(x)) return;
    vp.reset();
    e.preventDefault();
  };

  // Waveform layer: redrawn whenever the sample buffer or the viewport changes.
  createEffect(() => {
    const c = waveCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const data = props.sample.data;
    const start = vp.start();
    const end = Math.min(data.length, vp.end());

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
    const start = vp.start();
    const end = vp.end();

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
        {(info) => <WaveformCursorReadout info={info()} />}
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
  drawLoopBand(ctx, xForByte(loopStart), xForByte(loopStart + loopLen), w, h);
}
