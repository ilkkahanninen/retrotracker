/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor that streams audio from a Replayer.
 *
 * Loaded by `engine.ts` via `audioContext.audioWorklet.addModule(...)`.
 * Vite bundles imports together, so we can pull in the full Replayer here.
 */

import type { Sample, Song } from "../mod/types";
import { CHANNELS } from "../mod/types";
import { speedTempoAt } from "../mod/flatten";
import { Replayer } from "./replayer";
import type { AmigaModel } from "./paula";

export type WorkletMessage =
  | { type: "load"; song: Song }
  | { type: "play" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "playFrom"; order: number; row: number; loopPattern: boolean }
  | { type: "setChannelMuted"; channel: number; muted: boolean }
  | { type: "setAmigaModel"; model: AmigaModel }
  | { type: "setStereoSeparation"; sep: number }
  | { type: "setSampleData"; slot: number; sample: Sample };

export type WorkletEvent =
  | { type: "pos"; order: number; row: number }
  | { type: "level"; peaks: number[] };

/** UI-rate update cadence for VU level events (Hz). */
const LEVEL_UPDATE_HZ = 30;

class RetrotrackerProcessor extends AudioWorkletProcessor {
  private replayer: Replayer | null = null;
  private song: Song | null = null;
  private playing = false;
  // -1 forces an initial 'pos' post on the first process() call after load/play.
  private lastOrder = -1;
  private lastRow = -1;
  /**
   * Cached mute gate. Mirrors the main thread's effective audibility per
   * channel so the worklet can re-apply it whenever it builds a fresh
   * Replayer (load, end-of-song wrap, playFrom). Without this the gate
   * would silently reset on every replayer swap.
   */
  private readonly channelMuted: boolean[] = new Array(CHANNELS).fill(false);
  /**
   * Cached Paula filter model. Mirrors the user's Settings preference so
   * the worklet can re-apply it whenever it builds a fresh Replayer
   * (load, end-of-song wrap, playFrom). Without this the model would
   * silently revert to the Replayer default on every recreate.
   */
  private amigaModel: AmigaModel = "A1200";
  /** Cached stereo separation for the same reason as `amigaModel` —
   *  carries across replayer recreates. 20% is the pt2-clone default. */
  private stereoSeparation = 20;
  /**
   * VU-level throttle state. We accumulate frames since the last `level`
   * post and fire one when we cross the update interval — keeps the
   * message channel quiet (~30 Hz instead of one event per 128-frame
   * render quantum, ~344 Hz at 44.1 kHz).
   */
  private framesSinceLevels = 0;
  private readonly levelInterval = sampleRate / LEVEL_UPDATE_HZ;
  private readonly peakBuf = new Float32Array(CHANNELS);

  private applyChannelMuted(): void {
    if (!this.replayer) return;
    for (let ch = 0; ch < CHANNELS; ch++) {
      this.replayer.setChannelMuted(ch, this.channelMuted[ch]!);
    }
  }

  private applyAmigaModel(): void {
    this.replayer?.setAmigaModel(this.amigaModel);
  }

  private applyStereoSeparation(): void {
    this.replayer?.setStereoSeparation(this.stereoSeparation);
  }

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case "load":
          this.song = msg.song;
          this.replayer = new Replayer(msg.song, {
            sampleRate,
            loop: true,
            amigaModel: this.amigaModel,
            stereoSeparation: this.stereoSeparation,
          });
          this.applyChannelMuted();
          this.lastOrder = -1;
          this.lastRow = -1;
          break;
        case "play":
          // Replayer is one-shot — recreate it from the stored Song if the
          // previous run finished. This is what makes Play→end→Play work.
          if (this.song && (!this.replayer || this.replayer.isFinished())) {
            this.replayer = new Replayer(this.song, {
              sampleRate,
              loop: true,
              amigaModel: this.amigaModel,
            });
            this.applyChannelMuted();
            this.lastOrder = -1;
            this.lastRow = -1;
          }
          this.playing = true;
          break;
        case "stop":
          this.playing = false;
          // Force VU meters to silence on stop — `process()` short-circuits
          // out of the level-posting branch while paused, so without this
          // the UI would show frozen bars from the last playing quantum.
          this.framesSinceLevels = 0;
          this.port.postMessage({ type: "level", peaks: [0, 0, 0, 0] });
          break;
        case "reset":
          this.playing = false;
          this.replayer = null;
          this.song = null;
          break;
        case "playFrom":
          if (this.song) {
            // Seed the new Replayer with the speed/tempo that would be in
            // effect if the song had played from the start to the cursor —
            // otherwise mid-song playback always starts at the defaults
            // (6 / 125), even if the song set its tempo earlier.
            const { speed, tempo } = speedTempoAt(
              this.song,
              msg.order,
              msg.row,
            );
            this.replayer = new Replayer(this.song, {
              sampleRate,
              loop: true,
              initialOrder: msg.order,
              initialRow: msg.row,
              initialSpeed: speed,
              initialTempo: tempo,
              loopPattern: msg.loopPattern,
              amigaModel: this.amigaModel,
            });
            this.applyChannelMuted();
            this.lastOrder = -1;
            this.lastRow = -1;
            this.playing = true;
          }
          break;
        case "setChannelMuted":
          if (msg.channel >= 0 && msg.channel < CHANNELS) {
            this.channelMuted[msg.channel] = msg.muted;
            this.replayer?.setChannelMuted(msg.channel, msg.muted);
          }
          break;
        case "setAmigaModel":
          this.amigaModel = msg.model;
          this.applyAmigaModel();
          break;
        case "setStereoSeparation":
          this.stereoSeparation = msg.sep;
          this.applyStereoSeparation();
          break;
        case "setSampleData":
          // Hot-swap a single sample slot during playback. Both the cached
          // Song (used to recreate the Replayer on song-end wrap) and the
          // live Replayer share the same Song reference, so the
          // Replayer's `replaceSampleSlot` mutation is enough — no extra
          // bookkeeping here. No-op when no song is loaded yet.
          if (this.song && this.replayer) {
            this.replayer.replaceSampleSlot(msg.slot, msg.sample);
          }
          break;
      }
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
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
        this.replayer = new Replayer(this.song, {
          sampleRate,
          loop: true,
          amigaModel: this.amigaModel,
        });
        this.applyChannelMuted();
        this.lastOrder = -1;
        this.lastRow = -1;
      }

      const o = this.replayer.getOrderIndex();
      const r = this.replayer.getRow();
      if (o !== this.lastOrder || r !== this.lastRow) {
        this.lastOrder = o;
        this.lastRow = r;
        const evt: WorkletEvent = { type: "pos", order: o, row: r };
        this.port.postMessage(evt);
      }

      this.framesSinceLevels += left.length;
      if (this.framesSinceLevels >= this.levelInterval) {
        this.framesSinceLevels = 0;
        this.replayer.peakSnapshotAndReset(this.peakBuf);
        const evt: WorkletEvent = {
          type: "level",
          peaks: [
            this.peakBuf[0]!,
            this.peakBuf[1]!,
            this.peakBuf[2]!,
            this.peakBuf[3]!,
          ],
        };
        this.port.postMessage(evt);
      }
    } else {
      left.fill(0);
      right.fill(0);
    }
    return true;
  }
}

registerProcessor("retrotracker", RetrotrackerProcessor);
