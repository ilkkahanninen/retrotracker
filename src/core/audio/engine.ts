import workletUrl from './worklet?worker&url';
import type { Song } from '../mod/types';
import type { WorkletEvent, WorkletMessage } from './worklet';

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
  /** Called whenever the replayer crosses a row boundary during playback. */
  onPosition: ((order: number, row: number) => void) | null = null;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
    this.node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      const data = e.data;
      if (data.type === 'pos') this.onPosition?.(data.order, data.row);
    };
  }

  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'retrotracker', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    return new AudioEngine(ctx, node);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  load(song: Song): void {
    const msg: WorkletMessage = { type: 'load', song };
    this.node.port.postMessage(msg);
  }

  async play(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const msg: WorkletMessage = { type: 'play' };
    this.node.port.postMessage(msg);
  }

  /**
   * Restart playback at a specific (order, row). With `loopPattern`, playback
   * is locked to the starting order's pattern (FT2 F7 behavior).
   */
  async playFrom(order: number, row: number, opts: { loopPattern?: boolean } = {}): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const msg: WorkletMessage = {
      type: 'playFrom',
      order,
      row,
      loopPattern: opts.loopPattern ?? false,
    };
    this.node.port.postMessage(msg);
  }

  stop(): void {
    const msg: WorkletMessage = { type: 'stop' };
    this.node.port.postMessage(msg);
  }

  async dispose(): Promise<void> {
    this.node.disconnect();
    await this.ctx.close();
  }
}
