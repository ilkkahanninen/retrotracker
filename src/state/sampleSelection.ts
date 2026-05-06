import { createSignal } from "solid-js";

/**
 * Half-open byte range over the int8 sample data. `start` and `end` are
 * indices into `Sample.data` (a `Int8Array`); `end - start` is the
 * selection's length in bytes. Used by the SampleView for crop / cut /
 * range-aware effect ops.
 */
export interface SampleSelection {
  start: number;
  end: number;
}

/**
 * Active waveform selection in the SampleView. Lifted out of the
 * component so App-level keyboard shortcuts (Cmd+A "Select all") can
 * write to it without prop-drilling. Cleared whenever the user switches
 * sample slots — the selection only describes the slot it was drawn on.
 */
export const [sampleSelection, setSampleSelection] =
  createSignal<SampleSelection | null>(null);
