/**
 * Messages exchanged with the XM preview worklet. Lives in its own
 * file so engine.ts can import the types without pulling the worklet's
 * `AudioWorkletProcessor` module into the main bundle.
 */

import type { XmInstrument, XmSong } from "../xm/types";
import type { XmInterpolation } from "./types";

/** Start a fresh note: the preview song (see `buildXmPreviewSong`) and
 *  the mixer settings to play it with. */
export interface XmPreviewStartMsg {
  type: "start";
  song: XmSong;
  interpolation: XmInterpolation;
  ramping: boolean;
}

/** Swap the instrument under the sounding note without restarting it —
 *  a pipeline edit made while the key is held. */
export interface XmPreviewSwapMsg {
  type: "swap";
  instrument: XmInstrument;
}

export interface XmPreviewStopMsg {
  type: "stop";
}

export type XmPreviewMsg =
  XmPreviewStartMsg | XmPreviewSwapMsg | XmPreviewStopMsg;

/** Worklet → main-thread notifications. */
export interface XmPreviewEndedMsg {
  type: "ended";
}

export type XmPreviewOutMsg = XmPreviewEndedMsg;
