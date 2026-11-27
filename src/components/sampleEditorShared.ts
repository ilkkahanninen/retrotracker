import { EFFECT_LABELS, type EffectKind } from "../core/audio/sampleWorkbench";

/**
 * Effect kinds that ride the selection toolbar as their own quick-add
 * buttons. Order matches the on-screen layout. Reused by both PT2's
 * SampleView and FT2's InstrumentView so the editors feel identical.
 */
export const EFFECT_BUTTON_KINDS: readonly EffectKind[] = [
  "reverse",
  "volume",
  "pitch",
  "normalize",
  "filter",
  "shaper",
  "crossfade",
] as const;

/** Hover hint that hints at selection-aware vs always-whole behaviour. */
export function titleForEffectButton(
  kind: EffectKind,
  hasSelection: boolean,
): string {
  const isRangeAware = kind === "reverse";
  const label = EFFECT_LABELS[kind];
  if (kind === "volume") {
    return "Append a Volume envelope (double-click on the waveform to add points)";
  }
  if (kind === "pitch") {
    return "Append a Pitch / playback-speed envelope — values >1 speed up (and shorten) the sample, <1 slow down (and stretch)";
  }
  if (!isRangeAware) return `Append ${label} to the effect chain`;
  return hasSelection
    ? `Append ${label} over the current selection`
    : `Append ${label} (whole sample — no selection)`;
}

/**
 * Drop focus from selects and checkboxes after the user commits a value,
 * so that subsequent piano-key presses ('a', 's', 'd', …) flow through
 * the global shortcut handler instead of being swallowed by the focused
 * <select> (which type-searches its options) or <input type="checkbox">
 * (where Space would re-toggle it). Text inputs and range sliders are
 * NOT blurred — text fields the user is mid-edit on shouldn't lose focus
 * on every keystroke, and sliders pass through letters per `focusKind`
 * in src/state/shortcuts.ts.
 *
 * `change` events bubble, so one handler at an editor's root covers
 * every nested control (pipeline selects, chiptune selects, loop /
 * dither controls) without per-component plumbing. Used by both PT2's
 * SampleView and FT2's InstrumentView.
 */
export function blurOnCommit(e: Event): void {
  const t = e.target;
  if (
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLInputElement && t.type === "checkbox")
  ) {
    t.blur();
  }
}

/**
 * `9xx` (Set Sample Offset) parameter that points closest to `frame`.
 * The param steps 256 frames and is capped at 0xFF — anything past
 * frame 65280 saturates to 9FF. The same in both formats: PT counts
 * bytes of its 8-bit data, FT2 counts sample frames.
 */
export function sampleOffsetParam(frame: number): string {
  const v = Math.min(0xff, frame >> 8);
  return `9${v.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Where the waveform's pointer readout sits and what it reports. */
export interface WaveformCursorInfo {
  /** Sample frame (PT: byte) under the pointer. */
  frame: number;
  /** Pointer position inside the waveform box, CSS px. */
  x: number;
  y: number;
  /** Show the readout left of the pointer — it is near the right edge,
   *  where the readout would be clipped by the box. */
  flipLeft: boolean;
}

/** Approximate readout width in CSS px — drives the edge flip. */
const CURSOR_INFO_FLIP_PX = 130;

/** Build the readout for a pointer event over `container`, or null when
 *  the box has no width (hidden pane). */
export function waveformCursorInfoAt(
  e: MouseEvent,
  container: HTMLElement,
  frame: number,
): WaveformCursorInfo | null {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const x = e.clientX - rect.left;
  return {
    frame,
    x,
    y: e.clientY - rect.top,
    flipLeft: x > rect.width - CURSOR_INFO_FLIP_PX,
  };
}
