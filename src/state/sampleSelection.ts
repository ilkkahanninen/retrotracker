import { createSignal } from "solid-js";

export interface SampleSelection {
  start: number;
  end: number;
}

export const [sampleSelection, setSampleSelection] =
  createSignal<SampleSelection | null>(null);
