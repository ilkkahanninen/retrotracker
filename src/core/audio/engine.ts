import workletUrl from './worklet?worker&url';
import type { Sample, Song } from '../mod/types';
import { PAULA_CLOCK_PAL } from '../mod/format';
import { songForPlayback } from './loopTruncate';
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
    // Snapshot the song with trailing-after-loop bytes dropped for any
    // looped samples — see loopTruncate.ts. Keeps the editor's stored data
    // intact (the waveform still shows the full post-pipeline int8) while
    // the worklet plays a version where loopEnd == sampleEnd, which
    // sidesteps the PT loopStart=0 quirk so loops sound the way the
    // editor's preview suggests.
    const msg: WorkletMessage = { type: 'load', song: songForPlayback(song) };
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

    // Store the buffer at the context's native rate (always ≥ 8 kHz, so it
    // sails past per-browser createBuffer minima) and let `playbackRate` do
    // the pitch shift. If we instead set the buffer's own sampleRate to the
    // Paula rate, low notes like C-1 (~4144 Hz) trip the Web Audio floor in
    // some browsers and the call throws — silent preview on the lowest octave.
    const paulaRate = PAULA_CLOCK_PAL / (period * 2);
    const bufferRate = this.ctx.sampleRate;

    const buffer = this.ctx.createBuffer(1, sample.data.byteLength, bufferRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sample.data.byteLength; i++) channel[i] = sample.data[i]! / 128;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = paulaRate / bufferRate;
    if (sample.loopLengthWords > 1) {
      // Loop boundaries are in seconds of buffer time, so they scale by
      // bufferRate (not paulaRate) — playbackRate stretches them at playback.
      source.loop = true;
      source.loopStart = (sample.loopStartWords * 2) / bufferRate;
      source.loopEnd = ((sample.loopStartWords + sample.loopLengthWords) * 2) / bufferRate;
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
