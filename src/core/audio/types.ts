import type { Mixer } from './mixer';

export type PaulaClock = 'PAL' | 'NTSC';

export interface ReplayerOptions {
  /** Output sample rate in Hz (e.g. 44100, 48000). */
  sampleRate: number;
  /** Paula CPU clock. PAL is the conventional default for ProTracker. */
  clock?: PaulaClock;
  /**
   * Initial speed (ticks per row). MOD songs default to 6.
   * Mostly here for tests; the song's Fxx commands override this at runtime.
   */
  initialSpeed?: number;
  /** Initial BPM. MOD default is 125. */
  initialTempo?: number;
  /**
   * Stereo separation 0..100. 100 = full Amiga hard-pan (LRRL); 0 = mono.
   * pt2-clone defaults to 20, which is what the accuracy test bed uses.
   */
  stereoSeparation?: number;
  /**
   * If true, the replayer never reports end-of-song. Bxx that targets an
   * already-played row is treated as the song's loop point (which is its
   * intended use in MOD files), and running off the end falls back to
   * order 0. Use for live playback. Default false (offline render needs a
   * deterministic end).
   */
  loop?: boolean;
  /** Order index to start playback at. Defaults to 0. */
  initialOrder?: number;
  /** Pattern-relative row to start playback at. Defaults to 0. */
  initialRow?: number;
  /**
   * If true, playback never advances past the starting order's pattern.
   * End-of-pattern wraps to row 0 of the same pattern; Bxx is clamped to
   * the current order; Dxx still applies its row-jump within the pattern.
   * Implies `loop` semantics (the visited-set check is skipped). Used for
   * F7 "play pattern" in the live editor.
   */
  loopPattern?: boolean;
  /**
   * Optional mixer factory. Defaults to constructing a Paula (BLEP + RC/LED).
   * Pass a CleanMixer factory for the offline "Bounce selection" path where
   * the user wants a high-quality render free of Paula's analog character.
   */
  mixerFactory?: (sampleRate: number) => Mixer;
}

export interface RenderOptions extends ReplayerOptions {
  /** Hard cap on render length, regardless of song-end detection. */
  maxSeconds: number;
  /**
   * If true, stop when the replayer reports end-of-song (one full play-through
   * with no Bxx loop encountered). Defaults to true.
   */
  stopOnSongEnd?: boolean;
}

export interface RenderedAudio {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}
