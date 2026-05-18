import { Mp3Encoder } from "@breezystack/lamejs";
import type { RenderedAudio } from "./types";

// LAME's natural frame size. Feeding `encodeBuffer` slices of this length
// keeps internal buffering aligned and avoids needless reallocations.
const FRAME = 1152;

// Yield to the UI thread roughly every ~370 ms of audio (16 * 1152 frames at
// 44.1 kHz). The lamejs library is pure JS so the loop blocks otherwise.
const YIELD_EVERY_SLICES = 16;

const DEFAULT_BITRATE_KBPS = 192;

/**
 * Encode a rendered stereo Float32 buffer to MP3 bytes.
 *
 * Lazy-loaded — keep imports minimal here so Vite splits the encoder
 * library into the same chunk and nothing else.
 */
export async function encodeMp3(
  audio: RenderedAudio,
  opts: { bitRate?: number; onProgress?: (frac: number) => void } = {},
): Promise<Uint8Array> {
  const bitRate = opts.bitRate ?? DEFAULT_BITRATE_KBPS;
  const left16 = floatToInt16(audio.left);
  const right16 = floatToInt16(audio.right);
  const total = left16.length;

  const enc = new Mp3Encoder(2, audio.sampleRate, bitRate);
  const parts: Uint8Array[] = [];
  let slicesSinceYield = 0;

  opts.onProgress?.(0);
  for (let off = 0; off < total; off += FRAME) {
    const end = Math.min(off + FRAME, total);
    const l = left16.subarray(off, end);
    const r = right16.subarray(off, end);
    const out = enc.encodeBuffer(l, r);
    if (out.length > 0) parts.push(out);
    slicesSinceYield++;
    if (slicesSinceYield >= YIELD_EVERY_SLICES) {
      slicesSinceYield = 0;
      opts.onProgress?.(end / total);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const tail = enc.flush();
  if (tail.length > 0) parts.push(tail);
  opts.onProgress?.(1);

  return concatBytes(parts);
}

function floatToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    const clamped = x < -1 ? -1 : x > 1 ? 1 : x;
    out[i] = (clamped * 32767) | 0;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
