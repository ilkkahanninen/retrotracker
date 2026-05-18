import type { Song } from "../song";
import { makeReplayer } from "./replayerCommon";
import type { RenderOptions, RenderedAudio } from "./types";

const CHUNK = 1024;

/**
 * Render a song to stereo Float32 buffers offline. Used by the accuracy
 * test bed and the CLI. Dispatches via `makeReplayer` so PT2 and FT2
 * songs both render through the same path.
 */
export function renderToBuffer(song: Song, opts: RenderOptions): RenderedAudio {
  const stopOnSongEnd = opts.stopOnSongEnd ?? true;
  const maxFrames = Math.ceil(opts.maxSeconds * opts.sampleRate);

  const replayer = makeReplayer(song, opts);
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

/**
 * Same as {@link renderToBuffer} but yields to the event loop every
 * `YIELD_FRAMES` frames so the UI stays responsive on long renders. The
 * caller's `onYield` runs at each yield point — used by the MP3 export to
 * push a heartbeat to the progress modal (true fraction is unknowable
 * when `stopOnSongEnd` is true and the song length is implicit).
 */
const YIELD_FRAMES = CHUNK * 16; // ~370 ms of audio at 44.1 kHz

export async function renderToBufferAsync(
  song: Song,
  opts: RenderOptions & { onYield?: () => void },
): Promise<RenderedAudio> {
  const stopOnSongEnd = opts.stopOnSongEnd ?? true;
  const maxFrames = Math.ceil(opts.maxSeconds * opts.sampleRate);

  const replayer = makeReplayer(song, opts);
  const left = new Float32Array(maxFrames);
  const right = new Float32Array(maxFrames);

  let pos = 0;
  let sinceYield = 0;
  while (pos < maxFrames) {
    const want = Math.min(CHUNK, maxFrames - pos);
    replayer.process(left, right, want, pos);
    pos += want;
    sinceYield += want;
    if (stopOnSongEnd && replayer.isFinished()) break;
    if (sinceYield >= YIELD_FRAMES) {
      sinceYield = 0;
      opts.onYield?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  if (pos === maxFrames) {
    return { sampleRate: opts.sampleRate, left, right };
  }
  return {
    sampleRate: opts.sampleRate,
    left: left.subarray(0, pos),
    right: right.subarray(0, pos),
  };
}
