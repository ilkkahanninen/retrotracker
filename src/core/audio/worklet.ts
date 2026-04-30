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

export type WorkletEvent = { type: 'pos'; order: number; row: number };

class RetrotrackerProcessor extends AudioWorkletProcessor {
  private replayer: Replayer | null = null;
  private song: Song | null = null;
  private playing = false;
  // -1 forces an initial 'pos' post on the first process() call after load/play.
  private lastOrder = -1;
  private lastRow = -1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'load':
          this.song = msg.song;
          this.replayer = new Replayer(msg.song, { sampleRate, loop: true });
          this.lastOrder = -1;
          this.lastRow = -1;
          break;
        case 'play':
          // Replayer is one-shot — recreate it from the stored Song if the
          // previous run finished. This is what makes Play→end→Play work.
          if (this.song && (!this.replayer || this.replayer.isFinished())) {
            this.replayer = new Replayer(this.song, { sampleRate, loop: true });
            this.lastOrder = -1;
            this.lastRow = -1;
          }
          this.playing = true;
          break;
        case 'stop':
          this.playing = false;
          break;
        case 'reset':
          this.playing = false;
          this.replayer = null;
          this.song = null;
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

      // Loop: when the replayer reports end-of-song, swap in a fresh one so
      // the *next* render quantum starts from the song's beginning. The tail
      // of the current quantum may already be silence (the replayer writes
      // zeros after `ended` is set) — a sub-render-quantum gap on the order
      // of a few ms.
      if (this.replayer.isFinished() && this.song) {
        this.replayer = new Replayer(this.song, { sampleRate, loop: true });
        this.lastOrder = -1;
        this.lastRow = -1;
      }

      const o = this.replayer.getOrderIndex();
      const r = this.replayer.getRow();
      if (o !== this.lastOrder || r !== this.lastRow) {
        this.lastOrder = o;
        this.lastRow = r;
        const evt: WorkletEvent = { type: 'pos', order: o, row: r };
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
