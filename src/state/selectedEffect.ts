import { createSignal } from "solid-js";
import type {
  EffectKind,
  EnvelopeParamKey,
} from "../core/audio/sampleWorkbench";

/**
 * Index of the currently-selected effect in the active sample slot's
 * pipeline chain — the one whose visual editor (the envelope overlay on
 * the waveform) is active. `null` when nothing is selected.
 *
 * Lifted out of the component so PipelineEditor (where the user clicks)
 * and SampleView / Waveform (where the overlay renders) can read the
 * same source of truth without prop-drilling.
 *
 * Cleared on slot switch (the index points into the previous slot's
 * chain) and on chain mutations that reshuffle indices — `removeEffect`,
 * `moveEffect`, and the destructive parts of `addEffect`.
 */
export const [selectedEffectIndex, setSelectedEffectIndex] = createSignal<
  number | null
>(null);

/**
 * Which envelope of the selected effect is currently being edited. For
 * effects with one envelope (volume → "volume", shaper → "amount") this
 * is set automatically when the chain entry is selected. For filter
 * (cutoff + Q), the user toggles between the two via PipelineEditor's
 * param-selector buttons.
 *
 * `null` when no effect is selected, or the selected effect has no
 * animatable params (e.g. normalize / reverse / crop / cut / crossfade).
 */
export const [selectedEffectParam, setSelectedEffectParam] =
  createSignal<EnvelopeParamKey | null>(null);

/** Pick the default envelope to edit when a chain entry is freshly
 *  selected. Filter's primary param is cutoff; shaper's only one is
 *  amount; volume's only one is volume. Effects without animatable
 *  params (normalize / range-aware / crossfade) return `null`. */
export function defaultParamForKind(kind: EffectKind): EnvelopeParamKey | null {
  switch (kind) {
    case "volume":
      return "volume";
    case "filter":
      return "cutoff";
    case "shaper":
      return "amount";
    case "pitch":
      return "pitch";
    default:
      return null;
  }
}

export function clearSelectedEffect(): void {
  setSelectedEffectIndex(null);
  setSelectedEffectParam(null);
}
