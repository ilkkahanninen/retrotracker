/// <reference path="./audioworklet.d.ts" />
/**
 * AudioWorkletProcessor that auditions a single sample through a Paula
 * voice — same emulation path the song replayer uses, so a previewed
 * cycle sounds exactly like it would when triggered from a pattern.
 *
 * Loaded by `engine.ts` via `audioContext.audioWorklet.addModule(...)`.
 *
 * Why a worklet (and not an AudioBufferSourceNode):
 *   AudioBufferSourceNode captures its buffer at `start()`. Mutating the
 *   underlying Float32Array later isn't honoured in current Chrome —
 *   each rapid synth slider edit had to mint a brand-new source, which
 *   stacked many short-lived voices each starting at frame 0 of slightly
 *   different cycle data and summed into a buzzy distortion. The worklet
 *   holds the int8 data in regular memory and reads it per render
 *   quantum, so a `setSample` mid-play is picked up on the next byte
 *   fetch — the voice's phase, BLEP state, and filter history all carry
 *   through, gapless.
 */

import { Paula } from './paula';
import type { PreviewMsg } from './preview-worklet-types';

/** Replayer's NORM_FACTOR (2) / PAULA_VOICES (4). Single-voice headroom. */
const SCALE = 0.5;

/**
 * Voice channel used for preview. Voice 0 in Paula's LRRL panning is a
 * left channel, but we copy its mix to both output channels for a
 * centred mono audition (same amplitude perception as song playback at
 * full stereo width).
 */
const PREVIEW_CH = 0;

class PreviewProcessor extends AudioWorkletProcessor {
  private readonly paula: Paula;
  private playing = false;
  /** Last installed sample.data length in bytes — restart on changes. */
  private currentLengthBytes = 0;
  /** Reusable Float64 scratch for Paula's stereo output. */
  private scratchL: Float64Array = new Float64Array(0);
  private scratchR: Float64Array = new Float64Array(0);

  constructor() {
    super();
    this.paula = new Paula(sampleRate, 'A1200');
    this.port.onmessage = (e: MessageEvent<PreviewMsg>) => {
      const m = e.data;
      if (m.type === 'set') this.handleSet(m.data, m.period, m.volume, m.loopStartBytes, m.loopLengthWords);
      else if (m.type === 'stop') this.handleStop();
    };
  }

  private handleSet(
    data: Int8Array,
    period: number,
    volume: number,
    loopStartBytes: number,
    loopLengthWords: number,
  ): void {
    // Track length in BYTES — Paula's `lengthWords` and `loopLengthWords`
    // are both half a byte count, so we compare on the byte axis.
    const lenBytes = data.byteLength;
    const lengthWords = lenBytes >> 1;
    this.paula.setSample(PREVIEW_CH, data, 0, lengthWords, loopStartBytes, loopLengthWords);
    this.paula.setPeriod(PREVIEW_CH, period);
    this.paula.setVolume(PREVIEW_CH, volume);

    if (!this.playing) {
      // Fresh trigger — start DMA.
      this.paula.startDMA(PREVIEW_CH);
      this.playing = true;
    } else if (lenBytes !== this.currentLengthBytes) {
      // Length changed mid-play (cycleFrames or ratio slider snap). The
      // voice's `endBytes` was computed at the old startDMA and won't
      // wrap correctly. Restart so loop bounds are recomputed. Brief
      // discontinuity, but length changes are infrequent (octave snaps).
      this.paula.stopDMA(PREVIEW_CH);
      this.paula.startDMA(PREVIEW_CH);
    }
    // Same-length data updates fall through with no restart — the voice
    // continues its phase/BLEP/filter state, just reading the new byte
    // values. This is the hot path for slider drags.
    this.currentLengthBytes = lenBytes;
  }

  private handleStop(): void {
    this.paula.stopDMA(PREVIEW_CH);
    this.playing = false;
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0]!;
    const right = out[1] ?? left;
    const frames = left.length;

    if (!this.playing) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    if (this.scratchL.length < frames) {
      this.scratchL = new Float64Array(frames);
      this.scratchR = new Float64Array(frames);
    }
    const sL = this.scratchL;
    const sR = this.scratchR;
    this.paula.generate(sL, sR, frames, 0);

    // Voice 0 is panned to L; sR is silent. Copy L to both output
    // channels with the same NORM/voices scaling the Replayer applies,
    // so preview loudness matches song playback for the same sample.
    for (let i = 0; i < frames; i++) {
      const v = sL[i]! * SCALE;
      left[i] = v;
      if (right !== left) right[i] = v;
    }
    return true;
  }
}

registerProcessor('retrotracker-preview', PreviewProcessor);
