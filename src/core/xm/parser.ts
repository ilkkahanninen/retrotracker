import {
  readAsciiPadded,
  readI8,
  readU16LE,
  readU32LE,
  readU8,
} from "./byteReader";
import { deltaDecode16, deltaDecode8 } from "./delta";
import { emptyKeyMap, readKeyMap } from "./keymap";
import { unpackCell } from "./packing";
import {
  XM_KEYOFF_NOTE,
  XM_MAX_CHANNELS,
  XM_MAX_ENVELOPE_POINTS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_ORDERS,
  XM_MAX_PATTERN_ROWS,
  type XmAutoVibratoType,
  type XmEnvelope,
  type XmEnvelopePoint,
  type XmInstrument,
  type XmLoopType,
  type XmNote,
  type XmPattern,
  type XmSample,
  type XmSong,
} from "./types";

const XM_MAGIC = "Extended Module: ";
const XM_VERSION_REQUIRED = 0x0104;
const HEADER_FIXED_OFFSET = 60;

/**
 * Parse an FT2 .xm file into our internal model. Strict for now:
 * unknown versions, channel counts > 32, pattern counts > 256, or
 * instrument counts > 128 throw rather than silently clamping.
 */
export function parseXm(buffer: ArrayBufferLike | Uint8Array): XmSong {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteLength < HEADER_FIXED_OFFSET) {
    throw new Error(
      `XM too small: ${u8.byteLength} bytes (need at least ${HEADER_FIXED_OFFSET})`,
    );
  }

  // Magic
  for (let i = 0; i < XM_MAGIC.length; i++) {
    if (u8[i] !== XM_MAGIC.charCodeAt(i)) {
      throw new Error("Not an XM file (magic mismatch)");
    }
  }
  if (u8[37] !== 0x1a) {
    throw new Error("Invalid XM header (missing 0x1A separator)");
  }

  const title = readAsciiPadded(u8, 17, 20);
  const trackerName = readAsciiPadded(u8, 38, 20);
  const version = readU16LE(u8, 58);
  if (version !== XM_VERSION_REQUIRED) {
    throw new Error(
      `Unsupported XM version 0x${version.toString(16).padStart(4, "0")} ` +
        `(only 0x0104 is accepted)`,
    );
  }

  const headerSize = readU32LE(u8, 60);
  if (headerSize < 4) {
    throw new Error(`XM header size too small: ${headerSize}`);
  }
  const songLength = readU16LE(u8, 64);
  const restartPosition = readU16LE(u8, 66);
  const channelCount = readU16LE(u8, 68);
  const patternCount = readU16LE(u8, 70);
  const instrumentCount = readU16LE(u8, 72);
  const flagsRaw = readU16LE(u8, 74);
  const defaultTempo = readU16LE(u8, 76);
  const defaultBpm = readU16LE(u8, 78);

  if (channelCount < 2 || channelCount > XM_MAX_CHANNELS) {
    throw new Error(`Invalid XM channel count: ${channelCount}`);
  }
  if (patternCount > 256) {
    throw new Error(`Invalid XM pattern count: ${patternCount}`);
  }
  if (instrumentCount > XM_MAX_INSTRUMENTS) {
    throw new Error(`Invalid XM instrument count: ${instrumentCount}`);
  }
  if (songLength < 1 || songLength > XM_MAX_ORDERS) {
    throw new Error(`Invalid XM song length: ${songLength}`);
  }

  // Order list — always 256 bytes regardless of declared songLength.
  const orderListOffset = 60 + headerSize - 256;
  if (orderListOffset < 80 || orderListOffset + 256 > u8.byteLength) {
    throw new Error("XM header size points past the file");
  }
  const orders: number[] = new Array(XM_MAX_ORDERS);
  for (let i = 0; i < XM_MAX_ORDERS; i++) {
    orders[i] = u8[orderListOffset + i]!;
  }

  let cursor = 60 + headerSize;
  const patterns: XmPattern[] = new Array(patternCount);
  for (let p = 0; p < patternCount; p++) {
    const { pattern, consumed } = parsePattern(u8, cursor, channelCount);
    patterns[p] = pattern;
    cursor += consumed;
  }

  const instruments: XmInstrument[] = new Array(instrumentCount);
  for (let i = 0; i < instrumentCount; i++) {
    const { instrument, consumed } = parseInstrument(u8, cursor);
    instruments[i] = instrument;
    cursor += consumed;
  }

  return {
    format: "FT2",
    title,
    trackerName,
    version,
    channelCount,
    songLength,
    restartPosition,
    orders,
    patterns,
    instruments,
    flags: { linearFreq: (flagsRaw & 0x01) !== 0 },
    defaultTempo,
    defaultBpm,
  };
}

function parsePattern(
  u8: Uint8Array,
  base: number,
  channelCount: number,
): { pattern: XmPattern; consumed: number } {
  if (base + 9 > u8.byteLength) {
    throw new Error("XM pattern header truncated");
  }
  const headerLen = readU32LE(u8, base);
  // packingType = u8[base + 4]; always 0.
  const rowCount = readU16LE(u8, base + 5);
  const packedSize = readU16LE(u8, base + 7);
  if (rowCount < 1 || rowCount > XM_MAX_PATTERN_ROWS) {
    throw new Error(`Invalid XM pattern row count: ${rowCount}`);
  }
  const dataOff = base + headerLen;
  if (dataOff + packedSize > u8.byteLength) {
    throw new Error("XM pattern data truncated");
  }

  const rows: XmNote[][] = new Array(rowCount);
  if (packedSize === 0) {
    // Empty pattern shorthand.
    for (let r = 0; r < rowCount; r++) {
      const row: XmNote[] = new Array(channelCount);
      for (let c = 0; c < channelCount; c++) row[c] = emptyXmCell();
      rows[r] = row;
    }
  } else {
    let off = dataOff;
    const limit = dataOff + packedSize;
    for (let r = 0; r < rowCount; r++) {
      const row: XmNote[] = new Array(channelCount);
      for (let c = 0; c < channelCount; c++) {
        if (off >= limit) {
          throw new Error("XM pattern data ran out mid-row");
        }
        const { cell, consumed } = unpackCell(u8, off);
        row[c] = cell;
        off += consumed;
      }
      rows[r] = row;
    }
    if (off !== limit) {
      // Slack at the end of a pattern: tolerate it (some writers pad).
      // Not an error — packedSize wins.
    }
  }

  return {
    pattern: { rows, rowCount },
    consumed: headerLen + packedSize,
  };
}

function emptyXmCell(): XmNote {
  return { note: 0, instrument: 0, volumeColumn: 0, effect: 0, effectParam: 0 };
}

function parseInstrument(
  u8: Uint8Array,
  base: number,
): { instrument: XmInstrument; consumed: number } {
  if (base + 29 > u8.byteLength) {
    throw new Error("XM instrument header truncated");
  }
  const headerSize = readU32LE(u8, base);
  const name = readAsciiPadded(u8, base + 4, 22);
  // type byte at base+26 is always 0 in canonical FT2; some loaders
  // accept 0x80 too but we don't preserve it — FT2 zeroes it on save.
  const numSamples = readU16LE(u8, base + 27);

  let cursor = base + headerSize;
  let instrument: XmInstrument;
  let sampleHeaderSize = 40;

  if (numSamples === 0) {
    instrument = {
      name,
      samples: [],
      keyMap: emptyKeyMap(),
      volumeEnvelope: emptyEnvelope(),
      panningEnvelope: emptyEnvelope(),
      vibratoType: "sine",
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
      fadeout: 0,
    };
    return { instrument, consumed: headerSize };
  }

  // Extended instrument block — present when numSamples > 0.
  if (base + headerSize > u8.byteLength) {
    throw new Error("XM instrument extended block truncated");
  }
  sampleHeaderSize = readU32LE(u8, base + 29);
  const keyMap = readKeyMap(u8, base + 33);
  const volPoints = readEnvelopePoints(u8, base + 129, 12);
  const panPoints = readEnvelopePoints(u8, base + 177, 12);
  const volPointCount = clamp(
    readU8(u8, base + 225),
    0,
    XM_MAX_ENVELOPE_POINTS,
  );
  const panPointCount = clamp(
    readU8(u8, base + 226),
    0,
    XM_MAX_ENVELOPE_POINTS,
  );
  const volSustain = readU8(u8, base + 227);
  const volLoopStart = readU8(u8, base + 228);
  const volLoopEnd = readU8(u8, base + 229);
  const panSustain = readU8(u8, base + 230);
  const panLoopStart = readU8(u8, base + 231);
  const panLoopEnd = readU8(u8, base + 232);
  const volType = readU8(u8, base + 233);
  const panType = readU8(u8, base + 234);
  const vibratoType = decodeVibratoType(readU8(u8, base + 235));
  const vibratoSweep = readU8(u8, base + 236);
  const vibratoDepth = readU8(u8, base + 237);
  const vibratoRate = readU8(u8, base + 238);
  const fadeout = readU16LE(u8, base + 239);
  // 22 bytes reserved at base + 241.

  // Per-sample headers, then sample data.
  const sampleHeadersStart = cursor;
  const samples: XmSample[] = new Array(numSamples);
  const sampleHeaders: Array<{
    length: number; // bytes on disk
    loopStart: number; // bytes on disk
    loopLength: number; // bytes on disk
    volume: number;
    finetune: number;
    typeBits: number;
    panning: number;
    relativeNote: number;
    name: string;
  }> = [];
  for (let s = 0; s < numSamples; s++) {
    const off = sampleHeadersStart + s * sampleHeaderSize;
    if (off + sampleHeaderSize > u8.byteLength) {
      throw new Error("XM sample header truncated");
    }
    sampleHeaders.push({
      length: readU32LE(u8, off),
      loopStart: readU32LE(u8, off + 4),
      loopLength: readU32LE(u8, off + 8),
      volume: readU8(u8, off + 12),
      finetune: readI8(u8, off + 13),
      typeBits: readU8(u8, off + 14),
      panning: readU8(u8, off + 15),
      relativeNote: readI8(u8, off + 16),
      // off + 17 = reserved
      name: readAsciiPadded(u8, off + 18, 22),
    });
  }

  let dataCursor = sampleHeadersStart + numSamples * sampleHeaderSize;
  for (let s = 0; s < numSamples; s++) {
    const h = sampleHeaders[s]!;
    const is16 = (h.typeBits & 0x10) !== 0;
    const loopBits = h.typeBits & 0x03;
    const loopType: XmLoopType =
      loopBits === 1 ? "forward" : loopBits === 2 ? "ping-pong" : "none";

    if (dataCursor + h.length > u8.byteLength) {
      throw new Error("XM sample data truncated");
    }
    const raw = u8.subarray(dataCursor, dataCursor + h.length);
    dataCursor += h.length;

    let data: Int8Array | Int16Array;
    let bits: 8 | 16;
    let loopStart: number;
    let loopLength: number;
    if (is16) {
      data = deltaDecode16(raw);
      bits = 16;
      loopStart = h.loopStart >>> 1;
      loopLength = h.loopLength >>> 1;
    } else {
      data = deltaDecode8(raw);
      bits = 8;
      loopStart = h.loopStart;
      loopLength = h.loopLength;
    }
    // Clamp loop bounds: a malformed .xm can declare loopStart/loopLength past
    // the sample data, which the replayer and waveform editor both treat as
    // valid frame indices. Pin them inside [0, data.length] so out-of-range
    // values can't reach downstream code.
    if (loopStart > data.length) loopStart = data.length;
    if (loopStart + loopLength > data.length)
      loopLength = data.length - loopStart;

    samples[s] = {
      name: h.name,
      data,
      bits,
      loopStart,
      loopLength,
      loopType,
      volume: h.volume,
      finetune: h.finetune,
      panning: h.panning,
      relativeNote: h.relativeNote,
    };
  }

  instrument = {
    name,
    samples,
    keyMap,
    volumeEnvelope: buildEnvelope(volPoints.slice(0, volPointCount), {
      typeBits: volType,
      sustainPoint: volSustain,
      loopStart: volLoopStart,
      loopEnd: volLoopEnd,
    }),
    panningEnvelope: buildEnvelope(panPoints.slice(0, panPointCount), {
      typeBits: panType,
      sustainPoint: panSustain,
      loopStart: panLoopStart,
      loopEnd: panLoopEnd,
    }),
    vibratoType,
    vibratoSweep,
    vibratoDepth,
    vibratoRate,
    fadeout,
  };

  return { instrument, consumed: dataCursor - base };
}

function readEnvelopePoints(
  u8: Uint8Array,
  off: number,
  count: number,
): XmEnvelopePoint[] {
  const out: XmEnvelopePoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      tick: readU16LE(u8, off + i * 4),
      value: readU16LE(u8, off + i * 4 + 2),
    };
  }
  return out;
}

function emptyEnvelope(): XmEnvelope {
  return {
    enabled: false,
    sustainEnabled: false,
    loopEnabled: false,
    sustainPoint: 0,
    loopStart: 0,
    loopEnd: 0,
    points: [],
  };
}

function buildEnvelope(
  points: XmEnvelopePoint[],
  opts: {
    typeBits: number;
    sustainPoint: number;
    loopStart: number;
    loopEnd: number;
  },
): XmEnvelope {
  return {
    enabled: (opts.typeBits & 0x01) !== 0,
    sustainEnabled: (opts.typeBits & 0x02) !== 0,
    loopEnabled: (opts.typeBits & 0x04) !== 0,
    sustainPoint: opts.sustainPoint,
    loopStart: opts.loopStart,
    loopEnd: opts.loopEnd,
    points,
  };
}

function decodeVibratoType(raw: number): XmAutoVibratoType {
  switch (raw & 0x03) {
    case 1:
      return "square";
    case 2:
      return "ramp-down";
    case 3:
      return "ramp-up";
    default:
      return "sine";
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

void XM_KEYOFF_NOTE;
