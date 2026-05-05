import type { Song } from "../mod/types";
import { Replayer } from "./replayer";
import type { RenderOptions, RenderedAudio } from "./types";

const CHUNK = 1024;

/**
 * Render a Song to stereo Float32 buffers offline. Used by the accuracy
 * test bed and the CLI. Same Replayer instance powers the live AudioWorklet.
 */
export function renderToBuffer(song: Song, opts: RenderOptions): RenderedAudio {
  const stopOnSongEnd = opts.stopOnSongEnd ?? true;
  const maxFrames = Math.ceil(opts.maxSeconds * opts.sampleRate);

  const replayer = new Replayer(song, opts);
  const left = new Float32Array(maxFrames);
  const right = new Float32Array(maxFrames);

  let pos = 0;
  while (pos < maxFrames) {
    const want = Math.min(CHUNK, maxFrames - pos);
    replayer.process(left, right, want, pos);
    pos += want;
    if (stopOnSongEnd && replayer.isFinished()) break;
  }

  // If we stopped early, trim. Avoid copying when full length was used.
  if (pos === maxFrames) {
    return { sampleRate: opts.sampleRate, left, right };
  }
  return {
    sampleRate: opts.sampleRate,
    left: left.subarray(0, pos),
    right: right.subarray(0, pos),
  };
}
