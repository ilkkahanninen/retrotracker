/**
 * Shared message shape between the preview worklet and the main thread.
 * Pulled into its own file so engine.ts can import the types without
 * pulling the worklet's `AudioWorkletProcessor`-laden module into the
 * main bundle.
 */

import type { AmigaModel } from "./paula";

export interface PreviewSetMsg {
  type: "set";
  /** Int8 sample data (PT format, byte = signed 8-bit). */
  data: Int8Array;
  /** Paula period (113..856 typical). Pitches the voice. */
  period: number;
  /** PT volume 0..64. */
  volume: number;
  /** Loop start in BYTES. */
  loopStartBytes: number;
  /** Loop length in WORDS (PT convention; 1 = no-loop sentinel). */
  loopLengthWords: number;
}

export interface PreviewStopMsg {
  type: "stop";
}

export interface PreviewSetAmigaModelMsg {
  type: "setAmigaModel";
  model: AmigaModel;
}

export interface PreviewSetStereoSepMsg {
  type: "setStereoSeparation";
  /** Percentage 0..100. Same shape as `Settings.stereoSeparation`. */
  sep: number;
}

export type PreviewMsg =
  | PreviewSetMsg
  | PreviewStopMsg
  | PreviewSetAmigaModelMsg
  | PreviewSetStereoSepMsg;
