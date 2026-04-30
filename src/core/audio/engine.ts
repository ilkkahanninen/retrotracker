import workletUrl from './worklet?worker&url';
import type { Sample, Song } from '../mod/types';
import { PAULA_CLOCK_PAL } from '../mod/format';
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
  private previewSource: AudioBufferSourceNode | null = null;
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

  /**
   * Preview-play a sample at the given Paula period. Used by note-entry to
   * audition what the user just typed. Bypasses the worklet — runs as a plain
   * AudioBufferSourceNode through the AudioContext, so it's independent of
   * song playback.
   */
  async previewNote(sample: Sample, period: number): Promise<void> {
    if (sample.data.byteLength === 0 || period <= 0) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (this.previewSource) {
      try { this.previewSource.stop(); } catch { /* already stopped */ }
      this.previewSource.disconnect();
      this.previewSource = null;
    }

    const paulaRate = PAULA_CLOCK_PAL / (period * 2);
    // Browsers reject AudioBuffers outside roughly 3–96 kHz. Clamp defensively.
    const safeRate = Math.max(3000, Math.min(192000, paulaRate));

    const buffer = this.ctx.createBuffer(1, sample.data.byteLength, safeRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sample.data.byteLength; i++) channel[i] = sample.data[i]! / 128;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    if (sample.loopLengthWords > 1) {
      source.loop = true;
      source.loopStart = (sample.loopStartWords * 2) / safeRate;
      source.loopEnd = ((sample.loopStartWords + sample.loopLengthWords) * 2) / safeRate;
    }

    const gain = this.ctx.createGain();
    gain.gain.value = sample.volume / 64;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
    this.previewSource = source;
    source.onended = () => {
      if (this.previewSource === source) this.previewSource = null;
    };
  }

  /** Stop any active preview note. */
  stopPreview(): void {
    if (!this.previewSource) return;
    try { this.previewSource.stop(); } catch { /* already stopped */ }
    this.previewSource.disconnect();
    this.previewSource = null;
  }

  async dispose(): Promise<void> {
    this.stopPreview();
    this.node.disconnect();
    await this.ctx.close();
  }
}
