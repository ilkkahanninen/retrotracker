/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor that streams audio from a Pt2Replayer.
 *
 * Loaded by `engine.ts` via `audioContext.audioWorklet.addModule(...)`.
 * Vite bundles imports together, so we can pull in the full Pt2Replayer here.
 */

import type { Sample } from "../mod/types";
import { CHANNELS } from "../mod/types";
import { speedTempoAt } from "../mod/flatten";
import { speedTempoAtXm } from "../xm/flatten";
import type { Song } from "../song";
import { channelCount as channelCountOf } from "../song";
import { makeReplayer, type Replayer } from "./replayerCommon";
import type { Pt2Replayer } from "./replayer";
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
  | { type: "setSampleData"; slot: number; sample: Sample }
  | { type: "replaceSong"; song: Song }
  | { type: "setLoopPattern"; on: boolean };

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
   * replayer (load, end-of-song wrap, playFrom). Sized to the active
   * song's channel count (PT = 4, FT2 = 2..32) by `applyChannelCount`.
   */
  private channelMuted: boolean[] = new Array(CHANNELS).fill(false);
  /**
   * Cached Paula filter model. PT-only — XmReplayer ignores the setter
   * (it's optional on the Replayer interface), but we cache it so the
   * preview path and a future PT load still pick up the user's choice.
   */
  private amigaModel: AmigaModel = "A1200";
  /** Cached stereo separation (PT-only — XmReplayer ignores). */
  private stereoSeparation = 20;
  /**
   * VU-level throttle state. We accumulate frames since the last `level`
   * post and fire one when we cross the update interval — keeps the
   * message channel quiet (~30 Hz instead of one event per 128-frame
   * render quantum, ~344 Hz at 44.1 kHz).
   */
  private framesSinceLevels = 0;
  private readonly levelInterval = sampleRate / LEVEL_UPDATE_HZ;
  /**
   * Per-channel peak buffer. Dynamic-length so FT2 songs with more than
   * 4 channels report all of them; resized on load.
   */
  private peakBuf = new Float32Array(CHANNELS);

  private applyAmigaModel(): void {
    this.replayer?.setAmigaModel?.(this.amigaModel);
  }

  private applyStereoSeparation(): void {
    this.replayer?.setStereoSeparation?.(this.stereoSeparation);
  }

  /**
   * Resize per-channel buffers (mute gates, VU peaks) to match a freshly
   * loaded song's channel count. PT projects always size to 4; FT2 ranges
   * from 2..32. Idempotent.
   */
  private applyChannelCount(n: number): void {
    if (this.channelMuted.length !== n) {
      const next = new Array(n).fill(false) as boolean[];
      for (let i = 0; i < Math.min(n, this.channelMuted.length); i++) {
        next[i] = this.channelMuted[i] ?? false;
      }
      this.channelMuted = next;
    }
    if (this.peakBuf.length !== n) {
      this.peakBuf = new Float32Array(n);
    }
  }

  /**
   * One place to construct a fresh Pt2Replayer with every cached preference
   * carried in. Without this, each call site (load, play-after-finished,
   * playFrom, end-of-song wrap) had to remember to pass `amigaModel`,
   * `stereoSeparation`, and call `applyChannelMuted` — and at least
   * `stereoSeparation` was being silently dropped on every recreate but
   * `load`. Funnel through here so the worklet's cached state always
   * reaches the new Pt2Replayer.
   *
   * Mutes are passed via the constructor (not a post-construction
   * setChannelMuted loop) so they're in effect before the Pt2Replayer's
   * first internal `syncPaula` — otherwise a muted channel's row-0 note
   * triggers DMA at its full volume and only quiets at the next tick
   * (~20 ms of leak at default tempo).
   */
  private buildReplayer(
    extra: Partial<ConstructorParameters<typeof Pt2Replayer>[1]> = {},
  ): Replayer {
    if (!this.song) throw new Error("buildReplayer called with no song");
    this.applyChannelCount(channelCountOf(this.song));
    const r = makeReplayer(this.song, {
      sampleRate,
      loop: true,
      amigaModel: this.amigaModel,
      stereoSeparation: this.stereoSeparation,
      mutedChannels: this.channelMuted,
      ...extra,
    });
    this.lastOrder = -1;
    this.lastRow = -1;
    return r;
  }

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case "load":
          this.song = msg.song;
          this.replayer = this.buildReplayer();
          break;
        case "play":
          // Why: replayer is one-shot — recreate on finish to enable Play→end→Play.
          if (this.song && (!this.replayer || this.replayer.isFinished())) {
            this.replayer = this.buildReplayer();
          }
          this.playing = true;
          break;
        case "stop":
          this.playing = false;
          // Why: force VU meters to silence; process() skips level-posting while paused.
          this.framesSinceLevels = 0;
          this.port.postMessage({
            type: "level",
            peaks: new Array(this.peakBuf.length).fill(0) as number[],
          });
          break;
        case "reset":
          this.playing = false;
          this.replayer = null;
          this.song = null;
          break;
        case "playFrom":
          if (this.song) {
            // Why: seed with speed/tempo as-of cursor; otherwise mid-song
            // playback starts at defaults even if the song set tempo earlier.
            const seeded =
              this.song.format === "PT2"
                ? speedTempoAt(this.song, msg.order, msg.row)
                : speedTempoAtXm(this.song, msg.order, msg.row);
            this.replayer = this.buildReplayer({
              initialOrder: msg.order,
              initialRow: msg.row,
              initialSpeed: seeded.speed,
              initialTempo: seeded.tempo,
              loopPattern: msg.loopPattern,
            });
            this.playing = true;
          }
          break;
        case "setChannelMuted":
          if (msg.channel >= 0 && msg.channel < this.channelMuted.length) {
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
          // Hot-swap a single sample slot during playback (PT-only; the
          // FT2 path uses instruments and lands in a later slice). The
          // optional chain on the Replayer interface makes this a no-op
          // when the active replayer is XmReplayer.
          if (this.song && this.replayer) {
            this.replayer.replaceSampleSlot?.(msg.slot, msg.sample);
          }
          break;
        case "replaceSong":
          // Hot-swap the whole song reference (order list / pattern array
          // changes). Update both the cached ModSong and the live Pt2Replayer
          // so the next song-end-wrap recreate also picks up the new
          // shape. Sample data was already hot-swapped per-slot via
          // `setSampleData`, but `msg.song` is authoritative — pushing
          // it here keeps the worklet's snapshot consistent with the
          // editor's state.
          this.song = msg.song;
          this.replayer?.replaceSong(msg.song);
          break;
        case "setLoopPattern":
          // Flip the running replayer's Song↔Pattern flag without a
          // Stop+Play round-trip. The replayer picks up the new value at
          // the next pattern boundary.
          this.replayer?.setLoopPattern(msg.on);
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
        this.replayer = this.buildReplayer();
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
        // Why: postMessage would clone Float32Array to Array; engine's
        // onLevels expects number[] directly.
        const peaks = new Array<number>(this.peakBuf.length);
        for (let i = 0; i < this.peakBuf.length; i++) {
          peaks[i] = this.peakBuf[i]!;
        }
        const evt: WorkletEvent = { type: "level", peaks };
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
