/**
 * FastTracker 2 (.xm) data model.
 *
 * Variable channel count (2..32), variable per-pattern row count (1..256),
 * up to 128 instruments. Note pitch is a direct note number (1..96), not a
 * Paula period — the replayer (Phase 5) maps it through linear or Amiga
 * frequency tables depending on `flags.linearFreq`.
 *
 * Phase 1 of the .xm work only defines these types; parsing, writing, and
 * playback land in later phases.
 */

export const XM_MAX_CHANNELS = 32;
export const XM_MAX_INSTRUMENTS = 128;
export const XM_MAX_PATTERN_ROWS = 256;
export const XM_MIN_PATTERN_ROWS = 1;
export const XM_MAX_ORDERS = 256;
/** XM uses 97 to mean key-off (envelope release). 1..96 = C-0..B-7. */
export const XM_KEYOFF_NOTE = 97;
/** Envelope point capacity (XM stores up to 12 in vol/pan envelopes). */
export const XM_MAX_ENVELOPE_POINTS = 12;

export type XmLoopType = "none" | "forward" | "ping-pong";
export type XmAutoVibratoType = "sine" | "square" | "ramp-down" | "ramp-up";

export interface XmEnvelopePoint {
  /** Tick position. Monotonically increasing across an envelope. */
  tick: number;
  /** 0..64 for volume, 0..64 for panning (0 = full left, 64 = full right). */
  value: number;
}

export interface XmEnvelope {
  enabled: boolean;
  sustainEnabled: boolean;
  loopEnabled: boolean;
  /** Index into `points` of the sustain anchor. */
  sustainPoint: number;
  loopStart: number;
  loopEnd: number;
  /** 0..XM_MAX_ENVELOPE_POINTS points. */
  points: XmEnvelopePoint[];
}

export interface XmSample {
  /** 22-byte ASCII name. */
  name: string;
  /** Sample data, native bit depth. Length = data.length samples (not bytes). */
  data: Int8Array | Int16Array;
  /** 8 or 16. */
  bits: 8 | 16;
  /** Loop start in samples. */
  loopStart: number;
  /** Loop length in samples. 0 + loopType "none" = no loop. */
  loopLength: number;
  loopType: XmLoopType;
  /** 0..64. */
  volume: number;
  /** Signed -128..127 (XM's 8-bit signed finetune). */
  finetune: number;
  /** 0..255 (0 = full left, 128 = center, 255 = full right). */
  panning: number;
  /** -96..95 semitones. */
  relativeNote: number;
}

export interface XmInstrument {
  /** 22-byte ASCII name. */
  name: string;
  /**
   * Phase 1 carries one sample per instrument; the array is always length 1
   * unless multi-sample lands in a later phase. The keymap below already
   * indirects through this list so the migration is non-breaking.
   */
  samples: XmSample[];
  /** 96-byte note → sample-index map. All zeros until multi-sample lands. */
  keyMap: Uint8Array;
  volumeEnvelope: XmEnvelope;
  panningEnvelope: XmEnvelope;
  vibratoType: XmAutoVibratoType;
  /** 0..255 — ticks until the autovibrato reaches full depth. */
  vibratoSweep: number;
  /** 0..15. */
  vibratoDepth: number;
  /** 0..63. */
  vibratoRate: number;
  /** 0..32767 — amount subtracted from the 16-bit fade volume per tick after key-off. */
  fadeout: number;
}

export interface XmNote {
  /** 1..96 = C-0..B-7, 97 = key-off, 0 = no note. */
  note: number;
  /** 1..128 = instrument slot, 0 = no instrument change. */
  instrument: number;
  /** Volume column byte (0x00..0xFF). 0 = empty. See effectLabels for decoding. */
  volumeColumn: number;
  /** Effect index (0..0x21 ish — see XmEffect). */
  effect: number;
  /** Effect parameter byte. */
  effectParam: number;
}

export interface XmPattern {
  /** rowCount × channelCount. */
  rows: XmNote[][];
  /** 1..256. */
  rowCount: number;
}

export interface XmFlags {
  /** True = linear period table, false = Amiga period table. */
  linearFreq: boolean;
}

export interface XmSong {
  /** Discriminator for the cross-format Song union. */
  format: "FT2";
  /** 20-byte ASCII title. */
  title: string;
  /** 20-byte ASCII tracker name (informational, e.g. "FastTracker v2.00"). */
  trackerName: string;
  /** Version word (typically 0x0104 for canonical FT2 .xm files). */
  version: number;
  /** 2..32. */
  channelCount: number;
  /** 1..256. */
  songLength: number;
  restartPosition: number;
  /** Length 256 (XM_MAX_ORDERS), padded with zeros. */
  orders: number[];
  patterns: XmPattern[];
  /** Up to 128 instruments. */
  instruments: XmInstrument[];
  flags: XmFlags;
  /** Default speed (ticks/row), 1..31. */
  defaultTempo: number;
  /** Default BPM, 32..255. */
  defaultBpm: number;
}
