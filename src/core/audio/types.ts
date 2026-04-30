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
