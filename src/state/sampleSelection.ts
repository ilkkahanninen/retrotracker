import {
  createSampleSelectionSignal,
  type Range,
} from "./sampleSelectionStore";

export type SampleSelection = Range;

const s = createSampleSelectionSignal();
export const sampleSelection = s.signal;
export const setSampleSelection = s.set;
