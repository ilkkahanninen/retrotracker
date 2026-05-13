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
