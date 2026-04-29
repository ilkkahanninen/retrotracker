/**
 * Strict ProTracker M.K. data model.
 * 4 channels, 31 samples, 64 rows × 4 channels per pattern, up to 128 orders.
 */

export const ROWS_PER_PATTERN = 64;
export const CHANNELS = 4;
export const NUM_SAMPLES = 31;
export const MAX_ORDERS = 128;

export interface Sample {
  /** 22-byte ASCII name, null-padded. */
  name: string;
  /** Length in 16-bit words (multiply by 2 for bytes). 0..65535. */
  lengthWords: number;
  /** Signed 4-bit finetune, encoded 0..15. 0..7 = +0..+7, 8..15 = -8..-1. */
  finetune: number;
  /** 0..64. */
  volume: number;
  /** Loop start in words. */
  loopStartWords: number;
  /** Loop length in words. <=1 means no loop (PT writes 1, some write 0). */
  loopLengthWords: number;
  /** Signed 8-bit PCM samples. Length === lengthWords * 2. */
  data: Int8Array;
}

export interface Note {
  /** Paula period; 0 = no note. */
  period: number;
  /** 1..31; 0 = no sample change. */
  sample: number;
  /** Effect command nibble 0x0..0xF. */
  effect: number;
  /** Effect parameter byte 0x00..0xFF. */
  effectParam: number;
}

export interface Pattern {
  /** [ROWS_PER_PATTERN][CHANNELS] */
  rows: Note[][];
}

export interface Song {
  /** 20-byte ASCII title. */
  title: string;
  /** Always 31 entries (samples 1..31). Index 0 represents sample #1. */
  samples: Sample[];
  /** Number of orders used (1..128). */
  songLength: number;
  /** Historic NoiseTracker restart byte. PT writes 127. Preserved on read. */
  restartPosition: number;
  /** Pattern numbers. Length 128, padded with zeros. */
  orders: number[];
  /** Unique patterns (count = max(orders) + 1). */
  patterns: Pattern[];
  /** "M.K." for strict ProTracker. */
  signature: string;
}
