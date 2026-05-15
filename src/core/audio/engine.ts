import workletUrl from "./worklet?worker&url";
import previewWorkletUrl from "./preview-worklet?worker&url";
import xmPreviewWorkletUrl from "./xm-preview-worklet?worker&url";
import type { Sample } from "../mod/types";
import type { Song } from "../song";
import { songForPlayback, truncateSampleAtLoopEnd } from "./loopTruncate";
import type { WorkletEvent, WorkletMessage } from "./worklet";
import type { PreviewMsg } from "./preview-worklet-types";
import type { XmPreviewMsg, XmPreviewOutMsg } from "./xm-preview-worklet-types";
import type { AmigaModel } from "./paula";

/**
 * Browser-side wrapper around AudioContext + AudioWorkletNode.
 * Owns the worklet lifetime and exposes load/play/stop + position updates.
 *
 * Construct with `AudioEngine.create()` (async — has to register the worklet).
 *
 * Note: live playback loops the song forever. End-of-song wraps back to the
 * start inside the worklet, so there is no `onEnded` callback.
 */
export class AudioEngine {
  private readonly ctx: AudioContext;
  private readonly node: AudioWorkletNode;
  /**
   * Single GainNode the song worklet (and the preview worklet, on first
   * use) routes through before reaching `ctx.destination`. One node so
   * "master gain" is a single source of truth shared across both
   * audition (preview) and song playback — switching between them
   * doesn't change perceived loudness.
   */
  private readonly masterGainNode: GainNode;
  /**
   * Lazily-created preview worklet. Holds a single Paula voice with
   * hot-swappable sample data, so synth slider drags morph the voice
   * gaplessly without restarting it. Created on the first `previewNote`.
   */
  private previewNode: AudioWorkletNode | null = null;
  private previewModuleAdded = false;
  /**
   * Cached Paula filter model. Pushed to both worklets on every change
   * via `setPaulaModel`. The preview worklet is created lazily, so we
   * also re-apply this on first construction in `ensurePreviewNode`.
   */
  private paulaModel: AmigaModel = "A1200";
  /** Cached stereo separation, same lazy-preview reasoning as `paulaModel`. */
  private stereoSeparation = 20;
  /** Called whenever the replayer crosses a row boundary during playback. */
  onPosition: ((order: number, row: number) => void) | null = null;
  /**
   * Per-channel peak amplitude updates for VU meters. Fires at ~30 Hz
   * during playback and once with all zeros on stop so the UI can settle.
   * `peaks` is a 4-element array of pre-pan absolute values straight from
   * Paula's mix loop (typically [0, ~1.0]).
   */
  onLevels: ((peaks: number[]) => void) | null = null;

  private constructor(
    ctx: AudioContext,
    node: AudioWorkletNode,
    masterGainNode: GainNode,
  ) {
    this.ctx = ctx;
    this.node = node;
    this.masterGainNode = masterGainNode;
    this.node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      const data = e.data;
      if (data.type === "pos") this.onPosition?.(data.order, data.row);
      else if (data.type === "level") this.onLevels?.(data.peaks);
    };
  }

  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "retrotracker", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    // Why: initial gain matches engine cached default (1.4); reactive sync
    // re-pushes user's persisted value on mount.
    const masterGainNode = ctx.createGain();
    masterGainNode.gain.value = 1.4;
    node.connect(masterGainNode);
    masterGainNode.connect(ctx.destination);
    return new AudioEngine(ctx, node, masterGainNode);
  }

  /**
   * Build the preview AudioWorkletNode on demand. We don't register it
   * up-front because preview audio is only used in the sample editor —
   * playing a song never touches the preview path. The worklet module
   * is added on first use and cached.
   */
  private async ensurePreviewNode(): Promise<AudioWorkletNode> {
    if (this.previewNode) return this.previewNode;
    if (!this.previewModuleAdded) {
      await this.ctx.audioWorklet.addModule(previewWorkletUrl);
      this.previewModuleAdded = true;
    }
    const node = new AudioWorkletNode(this.ctx, "retrotracker-preview", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    // Route preview through the same master gain as the song worklet so
    // auditioning a sample tracks the user's playback-volume slider.
    node.connect(this.masterGainNode);
    this.previewNode = node;
    // Sync the cached model into the freshly-built preview worklet — the
    // worklet's own default (A1200) is correct only if the user hasn't
    // overridden it yet. Without this, opening the sample editor for the
    // first time after the user picked A500 would still preview through
    // A1200 filters until the next setPaulaModel call.
    const modelMsg: PreviewMsg = {
      type: "setAmigaModel",
      model: this.paulaModel,
    };
    node.port.postMessage(modelMsg);
    const sepMsg: PreviewMsg = {
      type: "setStereoSeparation",
      sep: this.stereoSeparation,
    };
    node.port.postMessage(sepMsg);
    return node;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  load(song: Song): void {
    // Why: PT snapshot drops trailing-after-loop bytes (see loopTruncate.ts) —
    // sidesteps the loopStart=0 quirk. FT2 has its own loop semantics.
    const playSong: Song = song.format === "PT2" ? songForPlayback(song) : song;
    const msg: WorkletMessage = { type: "load", song: playSong };
    this.node.port.postMessage(msg);
  }

  /**
   * Push a single sample slot's bytes + meta to the worklet without
   * restarting playback. The Pt2Replayer mutates its cached ModSong so future
   * note triggers use the new data, and re-latches Paula's voice
   * registers for any voice currently playing this slot — so a chiptune
   * morph audibly snaps into the new waveform within one loop period.
   *
   * Trailing-after-loop bytes are dropped here too (same loop-truncate
   * quirk as `load`), so the live update matches what a fresh load
   * would have sent.
   */
  setSampleData(slot: number, sample: Sample): void {
    const msg: WorkletMessage = {
      type: "setSampleData",
      slot,
      sample: truncateSampleAtLoopEnd(sample),
    };
    this.node.port.postMessage(msg);
  }

  /**
   * Push the whole song to the worklet without restarting playback.
   * Used for order-list edits (slot stepping, insert/delete, new /
   * duplicate pattern) — the Pt2Replayer keeps its mid-stream state
   * (orderIndex, row, channel voices) and the next row processed reads
   * from the new song. Trailing-after-loop bytes are dropped per sample
   * (same `songForPlayback` transform as `load`).
   */
  replaceSong(song: Song): void {
    const playSong: Song = song.format === "PT2" ? songForPlayback(song) : song;
    const msg: WorkletMessage = {
      type: "replaceSong",
      song: playSong,
    };
    this.node.port.postMessage(msg);
  }

  async play(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const msg: WorkletMessage = { type: "play" };
    this.node.port.postMessage(msg);
  }

  /**
   * Restart playback at a specific (order, row). With `loopPattern`, playback
   * is locked to the starting order's pattern (FT2 F7 behavior).
   */
  async playFrom(
    order: number,
    row: number,
    opts: { loopPattern?: boolean } = {},
  ): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const msg: WorkletMessage = {
      type: "playFrom",
      order,
      row,
      loopPattern: opts.loopPattern ?? false,
    };
    this.node.port.postMessage(msg);
  }

  stop(): void {
    const msg: WorkletMessage = { type: "stop" };
    this.node.port.postMessage(msg);
  }

  /**
   * Update the worklet's per-channel mute gate. Cheap to call repeatedly —
   * the worklet caches the gate across replayer recreations, and the audio
   * thread only spends a memory write per call.
   */
  setChannelMuted(channel: number, muted: boolean): void {
    const msg: WorkletMessage = { type: "setChannelMuted", channel, muted };
    this.node.port.postMessage(msg);
  }

  /**
   * Flip the running replayer's Song↔Pattern playback flag. Picked up at
   * the next pattern boundary so the user's toggle takes effect without a
   * Stop+Play round-trip.
   */
  setLoopPattern(on: boolean): void {
    const msg: WorkletMessage = { type: "setLoopPattern", on };
    this.node.port.postMessage(msg);
  }

  /**
   * Swap the Paula filter model on both the song and (if it exists) the
   * preview worklet. The model is also cached on the engine so that a
   * preview worklet created after this call still picks up the right
   * model on construction (see `ensurePreviewNode`).
   */
  setPaulaModel(model: AmigaModel): void {
    this.paulaModel = model;
    const songMsg: WorkletMessage = { type: "setAmigaModel", model };
    this.node.port.postMessage(songMsg);
    if (this.previewNode) {
      const previewMsg: PreviewMsg = { type: "setAmigaModel", model };
      this.previewNode.port.postMessage(previewMsg);
    }
  }

  /** Mirror of `setPaulaModel` for the stereo-separation slider. */
  setStereoSeparation(sep: number): void {
    this.stereoSeparation = sep;
    const songMsg: WorkletMessage = { type: "setStereoSeparation", sep };
    this.node.port.postMessage(songMsg);
    if (this.previewNode) {
      const previewMsg: PreviewMsg = { type: "setStereoSeparation", sep };
      this.previewNode.port.postMessage(previewMsg);
    }
  }

  /**
   * Set the live-playback master gain. `percent` is the user-facing
   * setting (100 = unity, 200 = +6 dB). Smoothed over ~10 ms via
   * `setTargetAtTime` so dragging the slider doesn't click. Both the
   * song and preview paths run through the same GainNode, so this
   * affects audition equally.
   *
   * Bypassed by `bounce` / WAV export and the offline render — both
   * call into the replayer directly without touching this node.
   */
  setMasterGain(percent: number): void {
    const linear = Math.max(0, percent) / 100;
    const param = this.masterGainNode.gain;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(linear, now, 0.01);
  }

  /**
   * Audition a sample at `period`. Routed through the preview worklet,
   * which holds a single Paula voice with hot-swappable sample data —
   * so rapid synth slider edits during a held key just patch the voice's
   * data/period/volume in place and the user hears one continuous voice
   * morph (no buffer-source restart, no click, no stacked sources).
   */
  async previewNote(sample: Sample, period: number): Promise<void> {
    if (sample.data.byteLength === 0 || period <= 0) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const node = await this.ensurePreviewNode();
    // Match what `engine.load` feeds the song worklet: drop trailing bytes
    // past loopEnd for looped samples (PT/Amiga loopStart=0 quirk — see
    // loopTruncate.ts). Without this, preview audio plays the full
    // post-pipeline buffer once before settling into the loop, while song
    // playback wraps at loopEnd — the two would disagree, defeating the
    // whole point of routing preview through Paula.
    const truncated = truncateSampleAtLoopEnd(sample);
    const msg: PreviewMsg = {
      type: "set",
      data: truncated.data,
      period,
      volume: truncated.volume,
      loopStartBytes: truncated.loopStartWords * 2,
      loopLengthWords: truncated.loopLengthWords,
    };
    node.port.postMessage(msg);
  }

  /**
   * Lazily-created XM preview worklet. Holds the stereo Float32 buffer
   * the host pre-rendered and advances a read pointer per render
   * quantum. Slider drags push fresh buffers without restarting the
   * read pointer (same gapless swap policy as PT2's preview worklet).
   */
  private xmPreviewNode: AudioWorkletNode | null = null;
  private xmPreviewModuleAdded = false;
  /** Current preview's onEnded callback, fired when the worklet posts
   *  back that the read pointer reached the buffer end. Doubles as
   *  the "is a preview currently audible on this engine?" gate read
   *  by `isXmPreviewActive`. */
  private xmPreviewOnEnded: (() => void) | null = null;

  /**
   * True while an XM preview buffer is loaded into the worklet AND
   * its natural-end callback hasn't fired yet. `xmLivePreviewSwap`
   * gates its re-render on this so a slider drag after a key-up
   * (which clears the callback) can't morph a no-longer-audible
   * voice into a fresh-sounding playback.
   */
  isXmPreviewActive(): boolean {
    return this.xmPreviewOnEnded !== null;
  }

  private async ensureXmPreviewNode(): Promise<AudioWorkletNode> {
    if (this.xmPreviewNode) return this.xmPreviewNode;
    if (!this.xmPreviewModuleAdded) {
      await this.ctx.audioWorklet.addModule(xmPreviewWorkletUrl);
      this.xmPreviewModuleAdded = true;
    }
    const node = new AudioWorkletNode(this.ctx, "retrotracker-xm-preview", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(this.masterGainNode);
    node.port.onmessage = (e: MessageEvent<XmPreviewOutMsg>) => {
      if (e.data.type === "ended") {
        const cb = this.xmPreviewOnEnded;
        this.xmPreviewOnEnded = null;
        cb?.();
      }
    };
    this.xmPreviewNode = node;
    return node;
  }

  /**
   * XM-flavoured preview: play a pre-rendered stereo buffer through
   * the XM preview worklet. The buffer is produced on the main thread
   * by running `XmReplayer` with a synthetic one-channel song — so
   * envelopes / autovibrato / fadeout / ping-pong all sound correct —
   * and the worklet holds it in regular memory and reads per render
   * quantum.
   *
   * `restart === true` resets the worklet's read pointer to frame 0
   * (fresh note trigger). `restart === false` keeps the read pointer
   * where it is, so a slider-drag-driven re-render morphs the audible
   * voice gaplessly (mirrors PT2's `paula.setSample` swap policy).
   */
  async playXmPreviewBuffer(
    left: Float32Array,
    right: Float32Array,
    _bufferSampleRate: number,
    onEnded?: () => void,
    restart: boolean = true,
  ): Promise<void> {
    void _bufferSampleRate;
    if (left.length === 0) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const node = await this.ensureXmPreviewNode();
    // Latest onEnded supersedes any prior one — the worklet only
    // signals once per natural end, and a swap is conceptually the
    // same trigger continuing under new audio.
    this.xmPreviewOnEnded = onEnded ?? null;
    const msg: XmPreviewMsg = { type: "set", left, right, restart };
    node.port.postMessage(msg);
  }

  /** Stop any active preview note. */
  stopPreview(): void {
    if (this.previewNode) {
      const msg: PreviewMsg = { type: "stop" };
      this.previewNode.port.postMessage(msg);
    }
    if (this.xmPreviewNode) {
      const msg: XmPreviewMsg = { type: "stop" };
      this.xmPreviewNode.port.postMessage(msg);
      // Suppress the natural-end onEnded callback for the buffer we
      // just cancelled — the caller didn't ask for it to fire.
      this.xmPreviewOnEnded = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopPreview();
    this.node.disconnect();
    await this.ctx.close();
  }
}
