/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor for FT2-mode note preview.
 *
 * The host pre-renders the preview audio on the main thread via
 * `XmReplayer` (so envelopes / autovibrato / fadeout sound right), then
 * pushes the resulting stereo Float32 buffer in via a `set` message.
 * The worklet holds the buffer and advances a read pointer per
 * render quantum; subsequent `set` messages REPLACE the buffer but
 * KEEP the read pointer, so a slider-drag re-render lands gaplessly
 * over the previous one — no click, no restart-from-zero.
 *
 * Equivalent to PT2's `preview-worklet.ts` swap policy
 * (`paula.setSample` without restarting DMA), adapted for XM's
 * pre-rendered buffer model.
 */

import type {
  XmPreviewEndedMsg,
  XmPreviewMsg,
} from "./xm-preview-worklet-types";

class XmPreviewProcessor extends AudioWorkletProcessor {
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private pos = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<XmPreviewMsg>) => {
      const m = e.data;
      if (m.type === "set") {
        this.left = m.left;
        this.right = m.right;
        // Fresh trigger → start at frame 0. Mid-preview swap → keep
        // the read pointer so the audible voice morphs gaplessly.
        if (m.restart) this.pos = 0;
        // If the new buffer is shorter than the current read pointer
        // (e.g. the user shrunk the chiptune cycle dramatically),
        // fall silent rather than accidentally jump back to frame 0.
        if (this.pos >= this.left.length) {
          this.signalEnded();
        }
      } else if (m.type === "stop") {
        this.left = null;
        this.right = null;
        this.pos = 0;
      }
    };
  }

  private signalEnded(): void {
    this.left = null;
    this.right = null;
    this.pos = 0;
    const msg: XmPreviewEndedMsg = { type: "ended" };
    this.port.postMessage(msg);
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0]!;
    const outR = out[1] ?? outL;
    const frames = outL.length;
    if (!this.left || !this.right) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }
    const remaining = this.left.length - this.pos;
    const want = Math.min(frames, remaining);
    // Copy a render-quantum's worth of audio.
    for (let i = 0; i < want; i++) {
      outL[i] = this.left[this.pos + i]!;
      outR[i] = this.right[this.pos + i]!;
    }
    // Zero-fill the tail after the buffer ends; matches AudioBuffer-
    // SourceNode's natural-end behaviour from the caller's perspective.
    for (let i = want; i < frames; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    this.pos += want;
    if (this.pos >= this.left.length) this.signalEnded();
    return true;
  }
}

registerProcessor("retrotracker-xm-preview", XmPreviewProcessor);
