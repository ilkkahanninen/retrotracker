import { CHANNELS, MAX_ORDERS, NUM_SAMPLES, ROWS_PER_PATTERN } from "./types";
import type { Note, Pattern, Sample, Song } from "./types";

const HEADER_SIZE = 1084;

/**
 * Parse a strict 4-channel ProTracker module ("M.K.").
 * Throws if the signature doesn't match. Other variants (xCHN, FLT4, etc.)
 * are out of scope by design.
 */
export function parseModule(buffer: ArrayBufferLike | Uint8Array): Song {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteLength < HEADER_SIZE) {
    throw new Error(
      `MOD too small: ${u8.byteLength} bytes (need at least ${HEADER_SIZE})`,
    );
  }

  const signature = readAscii(u8, 1080, 4);
  if (signature !== "M.K.") {
    throw new Error(
      `Unsupported MOD signature "${signature}". Only strict M.K. is accepted.`,
    );
  }

  const title = readAscii(u8, 0, 20);

  const samples: Sample[] = new Array(NUM_SAMPLES);
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const off = 20 + i * 30;
    const name = readAscii(u8, off, 22);
    const lengthWords = readU16BE(u8, off + 22);
    const finetune = u8[off + 24]! & 0x0f;
    const volume = Math.min(u8[off + 25]!, 64);
    const loopStartWords = readU16BE(u8, off + 26);
    const loopLengthWords = readU16BE(u8, off + 28);
    samples[i] = {
      name,
      lengthWords,
      finetune,
      volume,
      loopStartWords,
      loopLengthWords,
      data: new Int8Array(0), // filled below
    };
  }

  const songLength = u8[950]!;
  const restartPosition = u8[951]!;
  const orders = new Array<number>(MAX_ORDERS);
  let maxPattern = 0;
  for (let i = 0; i < MAX_ORDERS; i++) {
    orders[i] = u8[952 + i]!;
    if (orders[i]! > maxPattern) maxPattern = orders[i]!;
  }
  const numPatterns = maxPattern + 1;

  // Patterns
  const patterns: Pattern[] = new Array(numPatterns);
  let cursor = HEADER_SIZE;
  const patternSize = ROWS_PER_PATTERN * CHANNELS * 4;
  for (let p = 0; p < numPatterns; p++) {
    if (cursor + patternSize > u8.byteLength) {
      throw new Error(`Truncated pattern data at pattern ${p}`);
    }
    patterns[p] = readPattern(u8, cursor);
    cursor += patternSize;
  }

  // Sample data immediately follows pattern data, in sample-number order.
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const sample = samples[i]!;
    const byteLength = sample.lengthWords * 2;
    if (byteLength === 0) continue;
    if (cursor + byteLength > u8.byteLength) {
      // Some MODs ship truncated; clamp gracefully but keep length metadata.
      const available = Math.max(0, u8.byteLength - cursor);
      sample.data = new Int8Array(available);
      sample.data.set(
        new Int8Array(u8.buffer, u8.byteOffset + cursor, available),
      );
      cursor = u8.byteLength;
      continue;
    }
    sample.data = new Int8Array(byteLength);
    sample.data.set(
      new Int8Array(u8.buffer, u8.byteOffset + cursor, byteLength),
    );
    cursor += byteLength;
  }

  return {
    title,
    samples,
    songLength,
    restartPosition,
    orders,
    patterns,
    signature,
  };
}

function readPattern(u8: Uint8Array, base: number): Pattern {
  const rows: Note[][] = new Array(ROWS_PER_PATTERN);
  let off = base;
  for (let r = 0; r < ROWS_PER_PATTERN; r++) {
    const row: Note[] = new Array(CHANNELS);
    for (let c = 0; c < CHANNELS; c++) {
      row[c] = readNote(u8, off);
      off += 4;
    }
    rows[r] = row;
  }
  return { rows };
}

function readNote(u8: Uint8Array, off: number): Note {
  const b0 = u8[off]!;
  const b1 = u8[off + 1]!;
  const b2 = u8[off + 2]!;
  const b3 = u8[off + 3]!;
  // Layout: SSSSPPPPPPPPPPPP  SSSSEEEEPPPPPPPP
  //         (sample hi)(period 12)  (sample lo)(effect)(param)
  const sample = (b0 & 0xf0) | (b2 >> 4);
  const period = ((b0 & 0x0f) << 8) | b1;
  const effect = b2 & 0x0f;
  const effectParam = b3;
  return { period, sample, effect, effectParam };
}

function readAscii(u8: Uint8Array, off: number, len: number): string {
  let end = off;
  const stop = off + len;
  while (end < stop && u8[end] !== 0) end++;
  let s = "";
  for (let i = off; i < end; i++) {
    const c = u8[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "";
  }
  return s;
}

function readU16BE(u8: Uint8Array, off: number): number {
  return (u8[off]! << 8) | u8[off + 1]!;
}
