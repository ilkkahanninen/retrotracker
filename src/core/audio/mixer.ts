import type { AmigaModel } from "./paula";

/**
 * Surface area the Replayer uses to push channel state at a sample mixer.
 * Paula is one implementation (BLEP + RC/LED filters); CleanMixer is a
 * second one that skips Paula's analog character and resamples cleanly —
 * used by the offline "Bounce selection" feature where the user wants the
 * highest-quality possible render of a few rows / channels.
 *
 * Methods correspond 1:1 to Paula's existing public methods so that adding
 * the abstraction was a no-behavior-change refactor: the Replayer holds a
 * `Mixer` reference instead of a `Paula`, and any compliant mixer can ride.
 */
export interface Mixer {
  /**
   * Latch the sample registers for `ch`. Takes effect on the next `startDMA`
   * trigger; in-flight playback keeps reading from whatever was previously
   * latched, matching Paula's DMA quirk that PT effects rely on.
   */
  setSample(
    ch: number,
    data: Int8Array,
    startOffsetBytes: number,
    lengthWords: number,
    loopStartBytes: number,
    loopLengthWords: number,
  ): void;

  /** Set the playback period for `ch`. 0 → 65536; clamped to ≥113 (Paula min). */
  setPeriod(ch: number, period: number): void;

  /** Set the volume (0..64). */
  setVolume(ch: number, vol: number): void;

  /** Begin DMA for `ch` from the previously-latched start offset. */
  startDMA(ch: number): void;

  /** Stop DMA for `ch`. */
  stopDMA(ch: number): void;

  /** Toggle the LED low-pass filter (A500 hardware curve). */
  setLEDFilter(on: boolean): void;

  /**
   * Swap the active Amiga model at runtime. Mixers without analog
   * filtering (e.g. CleanMixer) treat this as a no-op.
   */
  setAmigaModel(model: AmigaModel): void;

  /** Emit `frames` stereo Float64 samples at the mixer's output rate. */
  generate(
    outL: Float64Array,
    outR: Float64Array,
    frames: number,
    offset: number,
  ): void;

  /** Read pre-pan per-channel peaks for VU meters; resets the accumulator. */
  peakSnapshotAndReset(out: Float32Array): void;
}
