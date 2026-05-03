import { createEffect, createSignal, type Component } from "solid-js";
import { useWindowListener } from "./hooks";
import type { Sample } from "../core/mod/types";
import { currentSample } from "../state/edit";
import { previewFrame } from "../state/preview";

/** A user-drawn range over the int8 sample data (byte indices, half-open). */
export interface SampleSelection {
  start: number;
  end: number;
}

/**
 * Min/max-bucketed PCM rendering. Two stacked canvases: the bottom one is
 * the waveform (repainted only when `props.sample` changes), the top one is
 * a transparent overlay that holds just the playhead (repainted on every
 * `previewFrame` tick). Splitting the layers keeps the heavy bucket loop
 * out of the 60 Hz update path and side-steps the "redraw the whole wave
 * to move the cursor" problem.
 */
export interface WaveformProps {
  sample: Sample;
  onPatch: (patch: Partial<Sample>) => void;
  selection: SampleSelection | null;
  onSelect: (s: SampleSelection | null) => void;
  /** When false, hide the loop overlay and ignore loop-handle drag. */
  showLoop: boolean;
}

/** Either dragging a loop boundary, or sweeping a selection range. */
type DragState =
  | { kind: "loop"; which: "start" | "end" }
  | { kind: "select"; anchorByte: number };

export const Waveform: Component<WaveformProps> = (props) => {
  let waveCanvas: HTMLCanvasElement | undefined;
  let playheadCanvas: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;
  const W = 1024;
  // Canvas internal height — kept in sync with --waveform-height (the box
  // it's drawn into). The canvas is upscaled via CSS, so a mismatch would
  // just produce a blurry waveform, not a layout break.
  const H = 160;
  /** Pointer must be within this many canvas-internal pixels of a loop line to grab it. */
  const HANDLE_HIT_PX = 8;

  /** Active drag, if any. */
  const [drag, setDrag] = createSignal<DragState | null>(null);
  /** Hover over a handle (drives cursor) — independent of drag because we
   *  also want the cursor while the user is grabbing. */
  const [hover, setHover] = createSignal<"start" | "end" | null>(null);

  /** Same byte→x mapping the waveform paths use, so the lines line up. */
  const xForByte = (byte: number, dataLen: number): number => {
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      return (byte / span) * (W - 1);
    }
    return (byte * W) / dataLen;
  };

  /** Inverse of xForByte: convert a canvas-internal x back to a byte index. */
  const byteForX = (x: number, dataLen: number): number => {
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      return Math.round((x / Math.max(1, W - 1)) * span);
    }
    return Math.round((x * dataLen) / W);
  };

  /** Convert a clientX from a mouse event to canvas-internal x (0..W). */
  const clientToCanvasX = (clientX: number): number => {
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  };

  /** Mouse-x near a loop boundary? Returns which one, or null. */
  const handleAt = (x: number): "start" | "end" | null => {
    const s = props.sample;
    if (!props.showLoop) return null;
    if (s.loopLengthWords <= 1) return null;
    const dataLen = s.data.length;
    if (dataLen === 0) return null;
    const xs = xForByte(s.loopStartWords * 2, dataLen);
    const xe = xForByte((s.loopStartWords + s.loopLengthWords) * 2, dataLen);
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? "start" : "end";
  };

  const onMouseDown = (e: MouseEvent) => {
    const x = clientToCanvasX(e.clientX);
    const handle = handleAt(x);
    if (handle) {
      setDrag({ kind: "loop", which: handle });
      e.preventDefault();
      return;
    }
    // Empty space → start a selection sweep. Anchor the start at the click
    // and let onMouseMove extend the end as the pointer moves.
    const dataLen = props.sample.data.length;
    if (dataLen === 0) return;
    const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
    setDrag({ kind: "select", anchorByte: byte });
    props.onSelect({ start: byte, end: byte });
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
    const dataLen = s.data.length;
    if (d.kind === "loop") {
      // Clamp to sample bounds and round to a word boundary (PT's loop fields
      // are word-aligned).
      const word = Math.max(
        0,
        Math.min(s.lengthWords, Math.round(byteForX(x, dataLen) / 2)),
      );
      if (d.which === "start") {
        // Keep at least 2 words of loop so the boundaries never cross.
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
      // Selection sweep — track the pointer in BYTE space (the user wants
      // sample-accurate boundaries, not word-aligned ones; the crop/cut
      // handlers are responsible for any alignment they need).
      const byte = Math.max(0, Math.min(dataLen, byteForX(x, dataLen)));
      props.onSelect({
        start: Math.min(d.anchorByte, byte),
        end: Math.max(d.anchorByte, byte),
      });
    }
  };

  const onMouseLeave = () => {
    if (!drag()) setHover(null);
  };

  // Window-level move/up while dragging, so the user can drag past the canvas
  // edge without losing the grab. Cleaned up the moment the drag ends.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => {
      // A click without movement (anchor === pointer) collapses the
      // selection — clear it so the action row doesn't linger empty.
      const d = drag();
      if (d?.kind === "select") {
        const sel = props.selection;
        if (sel && sel.start === sel.end) props.onSelect(null);
      }
      setDrag(null);
    };
    useWindowListener("mousemove", move);
    useWindowListener("mouseup", up);
  });

  // Waveform layer: redrawn only when the underlying sample changes.
  createEffect(() => {
    const c = waveCanvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // Background.
    ctx.fillStyle = "#1c1e26";
    ctx.fillRect(0, 0, W, H);

    // Center line.
    ctx.fillStyle = "#2a2d38";
    ctx.fillRect(0, H / 2, W, 1);

    const data = props.sample.data;
    if (data.byteLength === 0) return;

    ctx.fillStyle = "#5ec8ff";
    ctx.strokeStyle = "#5ec8ff";
    ctx.lineWidth = 1;
    const yFor = (v: number) => H / 2 - (v / 128) * (H / 2 - 1);

    if (data.length <= W) {
      // Short sample: every byte gets its own (possibly sub-pixel) x and we
      // trace a polyline through them. Stretches the wave to fill the canvas
      // and keeps adjacent samples visually connected.
      ctx.beginPath();
      const span = Math.max(1, data.length - 1);
      for (let i = 0; i < data.length; i++) {
        const x = (i / span) * (W - 1);
        const y = yFor(data[i]!);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      // More samples than pixels: bucket each column to its sample range and
      // fill a min/max bar. Bridge each bar to the previous column's last
      // sample so columns whose bucket holds only one sample still connect
      // visually to their neighbour.
      const samplesPerPixel = data.length / W;
      let prev: number | null = null;
      for (let x = 0; x < W; x++) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.min(
          data.length,
          Math.floor((x + 1) * samplesPerPixel),
        );
        if (start >= end) continue;
        let mn = 127;
        let mx = -128;
        if (prev !== null) {
          if (prev < mn) mn = prev;
          if (prev > mx) mx = prev;
        }
        for (let i = start; i < end; i++) {
          const v = data[i]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        prev = data[end - 1]!;
        const yMax = yFor(mx);
        const yMin = yFor(mn);
        ctx.fillRect(
          x,
          Math.min(yMax, yMin),
          1,
          Math.max(1, Math.abs(yMax - yMin)),
        );
      }
    }

    if (props.showLoop) drawLoopOverlay(ctx, props.sample, W, H, data.length);
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

    const dataLen = props.sample.data.length;

    // Selection overlay (drawn under the playhead so the cursor stays
    // legible across the highlighted band).
    const sel = props.selection;
    if (sel && dataLen > 0 && sel.end > sel.start) {
      const x0 = xForByte(sel.start, dataLen);
      const x1 = xForByte(sel.end, dataLen);
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.fillRect(Math.floor(x0), 0, 1, H);
      ctx.fillRect(Math.max(0, Math.floor(x1) - 1), 0, 1, H);
    }

    const pf = previewFrame();
    if (!pf || pf.slot !== currentSample() - 1) return;
    if (dataLen === 0) return;

    let x: number;
    if (dataLen <= W) {
      const span = Math.max(1, dataLen - 1);
      x = (pf.frame / span) * (W - 1);
    } else {
      x = (pf.frame * W) / dataLen;
    }
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
    </div>
  );
};

function drawLoopOverlay(
  ctx: CanvasRenderingContext2D,
  sample: Sample,
  w: number,
  h: number,
  dataLen: number,
): void {
  const loopStart = sample.loopStartWords * 2;
  const loopLen = sample.loopLengthWords * 2;
  if (loopLen <= 2 || dataLen <= 0) return;
  const x0 = Math.max(0, Math.min(w, (loopStart / dataLen) * w));
  const x1 = Math.max(0, Math.min(w, ((loopStart + loopLen) / dataLen) * w));
  ctx.fillStyle = "rgba(94, 200, 255, 0.18)";
  ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  ctx.fillStyle = "#5ec8ff";
  ctx.fillRect(x0, 0, 1, h);
  ctx.fillRect(Math.max(0, x1 - 1), 0, 1, h);
}
