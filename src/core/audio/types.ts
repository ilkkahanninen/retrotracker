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
