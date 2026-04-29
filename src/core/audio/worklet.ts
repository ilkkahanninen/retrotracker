/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor that streams audio from a Replayer.
 *
 * Loaded by `engine.ts` via `audioContext.audioWorklet.addModule(...)`.
 * Vite bundles imports together, so we can pull in the full Replayer here.
 */

import type { Song } from '../mod/types';
import { Replayer } from './replayer';

export type WorkletMessage =
  | { type: 'load'; song: Song }
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'reset' };

export type WorkletEvent = { type: 'ended' };

class RetrotrackerProcessor extends AudioWorkletProcessor {
  private replayer: Replayer | null = null;
  private playing = false;
  private endedNotified = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'load':
          this.replayer = new Replayer(msg.song, { sampleRate });
          this.endedNotified = false;
          break;
        case 'play':
          this.playing = true;
          this.endedNotified = false;
          break;
        case 'stop':
          this.playing = false;
          break;
        case 'reset':
          this.playing = false;
          this.replayer = null;
          break;
      }
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const left = out[0]!;
    const right = out[1]!;

    if (this.replayer && this.playing) {
      this.replayer.process(left, right, left.length);
      if (this.replayer.isFinished() && !this.endedNotified) {
        this.endedNotified = true;
        this.playing = false;
        const evt: WorkletEvent = { type: 'ended' };
        this.port.postMessage(evt);
      }
    } else {
      left.fill(0);
      right.fill(0);
    }
    return true;
  }
}

registerProcessor('retrotracker', RetrotrackerProcessor);
