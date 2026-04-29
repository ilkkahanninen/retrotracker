import { CHANNELS, MAX_ORDERS, NUM_SAMPLES, ROWS_PER_PATTERN } from './types';
import type { Note, Pattern, Sample, Song } from './types';

const HEADER_SIZE = 1084;

/**
 * Serialize a Song into a strict 4-channel ProTracker module ("M.K.").
 * Always writes 31 sample slots, 128 order entries, and signature "M.K.".
 */
export function writeModule(song: Song): Uint8Array {
  if (song.samples.length !== NUM_SAMPLES) {
    throw new Error(`Song must have exactly ${NUM_SAMPLES} samples (got ${song.samples.length})`);
  }
  if (song.orders.length !== MAX_ORDERS) {
    throw new Error(`Song must have exactly ${MAX_ORDERS} order entries`);
  }

  const numPatterns = song.patterns.length;
  const patternBytes = numPatterns * ROWS_PER_PATTERN * CHANNELS * 4;
  const sampleBytes = song.samples.reduce((sum, s) => sum + s.lengthWords * 2, 0);
  const total = HEADER_SIZE + patternBytes + sampleBytes;

  const u8 = new Uint8Array(total);
  writeAscii(u8, 0, 20, song.title);

  for (let i = 0; i < NUM_SAMPLES; i++) {
    writeSampleHeader(u8, 20 + i * 30, song.samples[i]!);
  }

  u8[950] = clamp(song.songLength, 1, MAX_ORDERS);
  u8[951] = song.restartPosition & 0xff;
  for (let i = 0; i < MAX_ORDERS; i++) {
    u8[952 + i] = song.orders[i]! & 0xff;
  }
  // Signature
  u8[1080] = 0x4d; // M
  u8[1081] = 0x2e; // .
  u8[1082] = 0x4b; // K
  u8[1083] = 0x2e; // .

  let cursor = HEADER_SIZE;
  for (let p = 0; p < numPatterns; p++) {
    cursor = writePattern(u8, cursor, song.patterns[p]!);
  }
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const sample = song.samples[i]!;
    const byteLength = sample.lengthWords * 2;
    if (byteLength === 0) continue;
    if (sample.data.byteLength < byteLength) {
      throw new Error(`Sample ${i + 1} data shorter than declared length`);
    }
    u8.set(sample.data.subarray(0, byteLength), cursor);
    cursor += byteLength;
  }
  return u8;
}

function writeSampleHeader(u8: Uint8Array, off: number, s: Sample): void {
  writeAscii(u8, off, 22, s.name);
  writeU16BE(u8, off + 22, s.lengthWords);
  u8[off + 24] = s.finetune & 0x0f;
  u8[off + 25] = clamp(s.volume, 0, 64);
  writeU16BE(u8, off + 26, s.loopStartWords);
  writeU16BE(u8, off + 28, Math.max(1, s.loopLengthWords));
}

function writePattern(u8: Uint8Array, base: number, pattern: Pattern): number {
  let off = base;
  for (let r = 0; r < ROWS_PER_PATTERN; r++) {
    const row = pattern.rows[r]!;
    for (let c = 0; c < CHANNELS; c++) {
      writeNote(u8, off, row[c]!);
      off += 4;
    }
  }
  return off;
}

function writeNote(u8: Uint8Array, off: number, n: Note): void {
  const sampleHi = n.sample & 0xf0;
  const sampleLo = (n.sample & 0x0f) << 4;
  const periodHi = (n.period >> 8) & 0x0f;
  const periodLo = n.period & 0xff;
  u8[off] = sampleHi | periodHi;
  u8[off + 1] = periodLo;
  u8[off + 2] = sampleLo | (n.effect & 0x0f);
  u8[off + 3] = n.effectParam & 0xff;
}

function writeAscii(u8: Uint8Array, off: number, len: number, s: string): void {
  for (let i = 0; i < len; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 0;
    u8[off + i] = c >= 0x20 && c < 0x7f ? c : 0;
  }
}

function writeU16BE(u8: Uint8Array, off: number, v: number): void {
  u8[off] = (v >> 8) & 0xff;
  u8[off + 1] = v & 0xff;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
