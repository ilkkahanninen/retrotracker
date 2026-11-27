/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor for FT2-mode note preview.
 *
 * Holds an `XmPreviewVoice` — an `XmReplayer` on a one-note song — and
 * runs it per render quantum, so a held note sounds until it is stopped
 * (or runs out by itself, which is reported back as `ended`). A `swap`
 * message replaces the instrument under the sounding note, so a slider
 * drag morphs the audible voice instead of restarting it.
 *
 * The FT2 counterpart of PT2's `preview-worklet.ts`, which does the same
 * with a Paula voice.
 */

import type {
  XmPreviewEndedMsg,
  XmPreviewMsg,
} from "./xm-preview-worklet-types";
import { XmPreviewVoice } from "./xmPreviewVoice";

class XmPreviewProcessor extends AudioWorkletProcessor {
  private readonly voice = new XmPreviewVoice(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<XmPreviewMsg>) => {
      const m = e.data;
      if (m.type === "start") {
        this.voice.start(m.song, {
          interpolation: m.interpolation,
          ramping: m.ramping,
        });
      } else if (m.type === "swap") {
        this.voice.swapInstrument(m.instrument);
      } else if (m.type === "stop") {
        this.voice.stop();
      }
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0]!;
    const outR = out[1] ?? outL;
    if (this.voice.process(outL, outR, outL.length)) {
      const msg: XmPreviewEndedMsg = { type: "ended" };
      this.port.postMessage(msg);
    }
    return true;
  }
}

registerProcessor("retrotracker-xm-preview", XmPreviewProcessor);
