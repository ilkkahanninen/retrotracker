import { createSignal } from "solid-js";

export type Mp3ExportPhase = "rendering" | "encoding";

export interface Mp3ExportState {
  phase: Mp3ExportPhase;
  /** Fraction in [0, 1]. NaN means indeterminate (render phase, where the
   *  natural song length is unknown until `isFinished()` fires). */
  frac: number;
}

export const [mp3ExportState, setMp3ExportState] =
  createSignal<Mp3ExportState | null>(null);
