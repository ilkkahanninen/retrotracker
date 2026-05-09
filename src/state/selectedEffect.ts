import { createSignal } from "solid-js";

/**
 * Index of the currently-selected effect in the active sample slot's
 * pipeline chain — the one whose visual editor (e.g. the volume envelope
 * overlay on the waveform) is active. `null` when nothing is selected.
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

export function clearSelectedEffect(): void {
  setSelectedEffectIndex(null);
}
