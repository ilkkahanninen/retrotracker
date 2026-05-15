/**
 * Format-agnostic replayer interface + factory. Both `Pt2Replayer` and
 * `XmReplayer` implement this contract; the worklet / engine / offline
 * render call `makeReplayer(song, opts)` and get back the right concrete
 * instance based on `song.format`.
 *
 * The PT-only methods (`replaceSampleSlot`, `setStereoSeparation`) are
 * optional on the interface so callers can feature-detect.
 */

import { Pt2Replayer } from "./replayer";
import type { Sample } from "../mod/types";
import type { Song } from "../song";
import type { ReplayerOptions } from "./types";
import { XmReplayer } from "./xmReplayer";

export interface Replayer {
  /** Render `frames` stereo samples into `left[offset..]` / `right[offset..]`. */
  process(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    offset?: number,
  ): void;

  /** Has the replayer reached song-end (only meaningful when not looping). */
  isFinished(): boolean;

  /** 0-based order list position. */
  getOrderIndex(): number;

  /** Row within the current pattern (0..rowCount-1). */
  getRow(): number;

  /** Live mute gate — independent of any tracker-driven volume. */
  setChannelMuted(channel: number, muted: boolean): void;

  /**
   * Flip the pattern-loop flag mid-playback. Picked up at the next
   * pattern boundary so the user's Song↔Pattern toggle takes effect
   * without a Stop+Play round-trip.
   */
  setLoopPattern(on: boolean): void;

  /**
   * Copy per-channel peak amplitudes into `out`, then reset internal
   * peaks. `out.length` should match the song's channel count;
   * implementations write only as many channels as they have.
   */
  peakSnapshotAndReset(out: Float32Array): void;

  /**
   * Hot-swap the song reference. Position (order/row) is preserved so a
   * mid-playback edit doesn't restart the song. Cross-format swaps are
   * rejected — caller must rebuild the replayer for that.
   */
  replaceSong(song: Song): void;

  /** PT-only: swap a single sample slot's data. */
  replaceSampleSlot?(slot: number, sample: Sample): void;

  /** PT-only: swap the stereo separation factor. */
  setStereoSeparation?(sep: number): void;

  /** PT-only: swap the Paula filter model (A500 / A1200). */
  setAmigaModel?(model: import("./paula").AmigaModel): void;
}

/**
 * Build the right replayer for `song.format`. Both concrete classes
 * already implement the `Replayer` interface; the factory hides the
 * branch from callers (worklet, engine, offline render, render-cli).
 */
export function makeReplayer(song: Song, opts: ReplayerOptions): Replayer {
  if (song.format === "PT2") {
    return new Pt2Replayer(song, opts);
  }
  return new XmReplayer(song, opts);
}
