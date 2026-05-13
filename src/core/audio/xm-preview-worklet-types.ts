/**
 * Messages exchanged with the XM preview worklet. Lives in its own
 * file so engine.ts can import the types without pulling the worklet's
 * `AudioWorkletProcessor` module into the main bundle.
 */

export interface XmPreviewSetMsg {
  type: "set";
  /** Stereo PCM buffers; the worklet copies references and starts (or
   *  continues) playback from the next render quantum. */
  left: Float32Array;
  right: Float32Array;
  /**
   * When true, reset the read pointer to 0 — a fresh note trigger.
   * When false, keep the read pointer where it is — a gapless mid-
   * preview swap (slider drag morphs the audio without restarting).
   */
  restart: boolean;
}

export interface XmPreviewStopMsg {
  type: "stop";
}

export type XmPreviewMsg = XmPreviewSetMsg | XmPreviewStopMsg;

/** Worklet → main-thread notifications. */
export interface XmPreviewEndedMsg {
  type: "ended";
}

export type XmPreviewOutMsg = XmPreviewEndedMsg;
