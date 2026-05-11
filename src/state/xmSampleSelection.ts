import { createSignal } from "solid-js";

/**
 * Half-open frame range over an XmSample's data array. `start` and
 * `end` are indices into `XmSample.data` (which is `Int8Array` for
 * 8-bit samples and `Int16Array` for 16-bit); `end - start` is the
 * selection's length in sample frames.
 *
 * XM doesn't use "byte" indexing the way PT does — PT samples are
 * always 8-bit so byte-index and frame-index coincide. XM's 16-bit
 * samples have `data.length` frames in `data.byteLength / 2` bytes,
 * so we index by frame to keep the selection meaningful across bit
 * depths.
 */
export interface XmSampleSelection {
  start: number;
  end: number;
}

/**
 * Active waveform selection in the FT2 instrument editor. Lifted out
 * of the component so App-level keyboard shortcuts (clipboard,
 * Select all, …) can write to it without prop-drilling. The selection
 * is bound to whichever (instrument, sample-index) the user is on at
 * the time it was drawn — switching either resets to null.
 */
export const [xmSampleSelection, setXmSampleSelection] =
  createSignal<XmSampleSelection | null>(null);

export function clearXmSampleSelection(): void {
  setXmSampleSelection(null);
}
