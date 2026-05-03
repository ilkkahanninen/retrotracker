import workletUrl from "./worklet?worker&url";
import previewWorkletUrl from "./preview-worklet?worker&url";
import type { Sample, Song } from "../mod/types";
import { songForPlayback, truncateSampleAtLoopEnd } from "./loopTruncate";
import type { WorkletEvent, WorkletMessage } from "./worklet";
import type { PreviewMsg } from "./preview-worklet-types";

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
   * Lazily-created preview worklet. Holds a single Paula voice with
   * hot-swappable sample data, so synth slider drags morph the voice
   * gaplessly without restarting it. Created on the first `previewNote`.
   */
  private previewNode: AudioWorkletNode | null = null;
  private previewModuleAdded = false;
  /** Called whenever the replayer crosses a row boundary during playback. */
  onPosition: ((order: number, row: number) => void) | null = null;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
    this.node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      const data = e.data;
      if (data.type === "pos") this.onPosition?.(data.order, data.row);
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
    node.connect(ctx.destination);
    return new AudioEngine(ctx, node);
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
    node.connect(this.ctx.destination);
    this.previewNode = node;
    return node;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  load(song: Song): void {
    // Snapshot the song with trailing-after-loop bytes dropped for any
    // looped samples — see loopTruncate.ts. Keeps the editor's stored data
    // intact (the waveform still shows the full post-pipeline int8) while
    // the worklet plays a version where loopEnd == sampleEnd, which
    // sidesteps the PT loopStart=0 quirk so loops sound the way the
    // editor's preview suggests.
    const msg: WorkletMessage = { type: "load", song: songForPlayback(song) };
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

  /** Stop any active preview note. */
  stopPreview(): void {
    if (!this.previewNode) return;
    const msg: PreviewMsg = { type: "stop" };
    this.previewNode.port.postMessage(msg);
  }

  async dispose(): Promise<void> {
    this.stopPreview();
    this.node.disconnect();
    await this.ctx.close();
  }
}
