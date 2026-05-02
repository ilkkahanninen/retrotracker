import type { Song, Sample } from '../mod/types';

/**
 * Sidestep PT/Amiga's loopStart=0 quirk by feeding the live-playback path
 * a song whose looped samples have `loopEnd == sampleEnd`. pt2-clone /
 * real Amiga DMA only truncates n_length to (loopStart + loopLength) when
 * loopStart > 0; with loopStart == 0 it plays the full sample once before
 * settling into the loop, which sounds wrong against the editor's
 * preview (Web Audio's source.loop never plays past loopEnd).
 *
 * This module is the editor-side fix: drop the trailing bytes ONLY in the
 * snapshot we hand to the worklet. The Song held on the main thread keeps
 * the full post-pipeline int8 — that's what the waveform shows, and the
 * user can drag the loop end back outward at any time. The trailing data
 * is preserved.
 *
 * The replayer itself stays bug-for-bug pt2-clone (offline-render
 * accuracy fixtures depend on that), so this transform is applied only
 * by `engine.load()` before postMessage to the worklet.
 */

/** Slice trailing bytes off a single Sample if it loops with `loopEnd < lengthWords`. */
export function truncateSampleAtLoopEnd(s: Sample): Sample {
  if (s.loopLengthWords <= 1) return s;
  const loopEndWords = s.loopStartWords + s.loopLengthWords;
  if (loopEndWords >= s.lengthWords) return s;
  return {
    ...s,
    data: s.data.slice(0, loopEndWords * 2),
    lengthWords: loopEndWords,
  };
}

/** Apply `truncateSampleAtLoopEnd` to every populated sample in the song. */
export function songForPlayback(song: Song): Song {
  return { ...song, samples: song.samples.map(truncateSampleAtLoopEnd) };
}
