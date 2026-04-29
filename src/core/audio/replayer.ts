import type { Song } from '../mod/types';
import { PAULA_CLOCK_NTSC, PAULA_CLOCK_PAL } from '../mod/format';
import type { ReplayerOptions } from './types';

/**
 * ProTracker replayer state machine.
 *
 * STATUS: stub. Currently produces silence and never advances song state.
 *
 * Architecture goal:
 *   - Pure mixer that fills Float32Array buffers given an immutable Song.
 *   - No DOM/AudioContext dependency, so the same code path runs offline
 *     for the accuracy test bed and live inside an AudioWorkletProcessor.
 *   - Reference behavior: 8bitbubsy/pt2-clone (BLEP, period quirks, Exx).
 */
export class Replayer {
  private readonly song: Song;
  private readonly sampleRate: number;
  private readonly paulaClock: number;
  private finished = false;

  constructor(song: Song, opts: ReplayerOptions) {
    this.song = song;
    this.sampleRate = opts.sampleRate;
    this.paulaClock = (opts.clock ?? 'PAL') === 'PAL' ? PAULA_CLOCK_PAL : PAULA_CLOCK_NTSC;
    void this.song;
    void this.paulaClock;
  }

  /** Fill `frames` samples into left/right buffers (offsets honored). */
  process(left: Float32Array, right: Float32Array, frames: number, offset = 0): void {
    if (left.length < offset + frames || right.length < offset + frames) {
      throw new Error('Output buffer too small');
    }
    // TODO: implement tick scheduler, channel mixer, BLEP resampling,
    // effect processing. For now, silence.
    for (let i = 0; i < frames; i++) {
      left[offset + i] = 0;
      right[offset + i] = 0;
    }
  }

  /** True after one full play-through with no Bxx loop encountered. */
  isFinished(): boolean {
    return this.finished;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }
}
