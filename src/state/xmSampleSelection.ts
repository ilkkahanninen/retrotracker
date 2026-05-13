import {
  createSampleSelectionSignal,
  type Range,
} from "./sampleSelectionStore";

// Why: half-open range indexed by FRAME (not byte) so selections stay valid
// across 8-bit / 16-bit XM samples.
export type XmSampleSelection = Range;

const s = createSampleSelectionSignal();
export const xmSampleSelection = s.signal;
export const setXmSampleSelection = s.set;
export const clearXmSampleSelection = s.clear;
