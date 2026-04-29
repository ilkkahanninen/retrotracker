/// <reference lib="webworker" />
/**
 * AudioWorkletProcessor that streams audio from a Replayer.
 *
 * Loaded with `audioContext.audioWorklet.addModule(...)` in the live engine.
 * The Song is sent over via `port.postMessage` and (re)constructed inside
 * the worklet to keep this file free of main-thread imports.
 *
 * STATUS: stub — wires the boilerplate so the worklet is registered and
 * receives messages, but it produces silence until Replayer is implemented.
 */

import type { Song } from '../mod/types';
import { Replayer } from './replayer';

type WorkletMessage =
  | { type: 'load'; song: Song }
  | { type: 'play' }
  | { type: 'stop' };

class RetrotrackerProcessor extends AudioWorkletProcessor {
  private replayer: Replayer | null = null;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const msg = e.data;
      if (msg.type === 'load') {
        this.replayer = new Replayer(msg.song, { sampleRate });
      } else if (msg.type === 'play') {
        this.playing = true;
      } else if (msg.type === 'stop') {
        this.playing = false;
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
    } else {
      left.fill(0);
      right.fill(0);
    }
    return true;
  }
}

registerProcessor('retrotracker', RetrotrackerProcessor);
