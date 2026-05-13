import { createSignal } from "solid-js";

// Why: half-open range indexed by FRAME (not byte) so selections stay valid
// across 8-bit / 16-bit XM samples — Int16 frames have data.length frames in
// data.byteLength/2 bytes.
export interface XmSampleSelection {
  start: number;
  end: number;
}

export const [xmSampleSelection, setXmSampleSelection] =
  createSignal<XmSampleSelection | null>(null);

export function clearXmSampleSelection(): void {
  setXmSampleSelection(null);
}
