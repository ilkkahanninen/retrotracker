import {
  writeAsciiPadded,
  writeI8,
  writeU16LE,
  writeU32LE,
  writeU8,
} from "./byteReader";
import { deltaEncode16, deltaEncode8 } from "./delta";
import { writeKeyMap } from "./keymap";
import { packCell } from "./packing";
import {
  XM_MAX_CHANNELS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_ORDERS,
  type XmEnvelope,
  type XmInstrument,
  type XmSample,
  type XmSong,
} from "./types";

const XM_MAGIC = "Extended Module: ";
const XM_HEADER_BODY_SIZE = 276; // canonical FT2 header size from offset 60 onward
const XM_VERSION_REQUIRED = 0x0104;
const PATTERN_HEADER_LEN = 9;
const INSTRUMENT_HEADER_SIZE_FULL = 263; // 29 + 234 ext block
const INSTRUMENT_HEADER_SIZE_EMPTY = 29; // when numSamples=0
const SAMPLE_HEADER_SIZE = 40;

/**
 * Serialize an `XmSong` into FT2 .xm bytes. Produces the canonical
 * shape: header size 276, instrument header size 263 with the extended
 * block when any sample is present, sample header size 40, and packed
 * patterns. Round-trips with `parseXm` byte-for-byte for any song that
 * we ourselves authored.
 */
export function writeXm(song: XmSong): Uint8Array {
  if (song.format !== "FT2") {
    throw new Error('writeXm: song.format must be "FT2"');
  }
  if (song.channelCount < 2 || song.channelCount > XM_MAX_CHANNELS) {
    throw new Error(`writeXm: invalid channelCount ${song.channelCount}`);
  }
  if (song.songLength < 1 || song.songLength > XM_MAX_ORDERS) {
    throw new Error(`writeXm: invalid songLength ${song.songLength}`);
  }
  if (song.instruments.length > XM_MAX_INSTRUMENTS) {
    throw new Error(`writeXm: too many instruments ${song.instruments.length}`);
  }
  if (song.orders.length !== XM_MAX_ORDERS) {
    throw new Error(`writeXm: orders must have length ${XM_MAX_ORDERS}`);
  }

  // Pre-encode patterns so we know their byte sizes.
  const patternBlobs = song.patterns.map((p) =>
    packPattern(p.rows, p.rowCount, song.channelCount),
  );
  // Pre-encode instruments.
  const instrumentBlobs = song.instruments.map((inst) => packInstrument(inst));

  let totalSize = 60 + XM_HEADER_BODY_SIZE;
  for (const b of patternBlobs) totalSize += b.byteLength;
  for (const b of instrumentBlobs) totalSize += b.byteLength;

  const out = new Uint8Array(totalSize);
  // Header.
  for (let i = 0; i < XM_MAGIC.length; i++) {
    out[i] = XM_MAGIC.charCodeAt(i);
  }
  writeAsciiPadded(out, 17, 20, song.title);
  out[37] = 0x1a;
  writeAsciiPadded(out, 38, 20, song.trackerName);
  writeU16LE(out, 58, XM_VERSION_REQUIRED);
  writeU32LE(out, 60, XM_HEADER_BODY_SIZE);
  writeU16LE(out, 64, song.songLength);
  writeU16LE(out, 66, song.restartPosition);
  writeU16LE(out, 68, song.channelCount);
  writeU16LE(out, 70, song.patterns.length);
  writeU16LE(out, 72, song.instruments.length);
  writeU16LE(out, 74, song.flags.linearFreq ? 1 : 0);
  writeU16LE(out, 76, song.defaultTempo);
  writeU16LE(out, 78, song.defaultBpm);
  // Order list lives at the end of the variable-length header. With
  // header body size 276, that's offset 60 + 276 - 256 = 80.
  for (let i = 0; i < XM_MAX_ORDERS; i++) {
    out[80 + i] = song.orders[i] ?? 0;
  }

  let cursor = 60 + XM_HEADER_BODY_SIZE;
  for (const blob of patternBlobs) {
    out.set(blob, cursor);
    cursor += blob.byteLength;
  }
  for (const blob of instrumentBlobs) {
    out.set(blob, cursor);
    cursor += blob.byteLength;
  }

  return out;
}

function packPattern(
  rows: XmSong["patterns"][number]["rows"],
  rowCount: number,
  channelCount: number,
): Uint8Array {
  // Encode the body first so we know its size.
  const cells: Uint8Array[] = [];
  let total = 0;
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r]!;
    for (let c = 0; c < channelCount; c++) {
      const blob = packCell(row[c]!);
      cells.push(blob);
      total += blob.byteLength;
    }
  }
  // FT2 represents an entirely-empty pattern as packedSize=0 (no body).
  let body: Uint8Array;
  let packedSize: number;
  if (cells.every((b) => b.byteLength === 1 && b[0] === 0x80)) {
    body = new Uint8Array(0);
    packedSize = 0;
  } else {
    body = new Uint8Array(total);
    let off = 0;
    for (const b of cells) {
      body.set(b, off);
      off += b.byteLength;
    }
    packedSize = total;
  }

  const out = new Uint8Array(PATTERN_HEADER_LEN + body.byteLength);
  writeU32LE(out, 0, PATTERN_HEADER_LEN);
  out[4] = 0; // packing type
  writeU16LE(out, 5, rowCount);
  writeU16LE(out, 7, packedSize);
  out.set(body, PATTERN_HEADER_LEN);
  return out;
}

function packInstrument(inst: XmInstrument): Uint8Array {
  if (inst.samples.length === 0) {
    const out = new Uint8Array(INSTRUMENT_HEADER_SIZE_EMPTY);
    writeU32LE(out, 0, INSTRUMENT_HEADER_SIZE_EMPTY);
    writeAsciiPadded(out, 4, 22, inst.name);
    out[26] = 0;
    writeU16LE(out, 27, 0);
    return out;
  }

  // Pre-encode sample data so we know total size.
  const sampleData: Uint8Array[] = inst.samples.map((s) => encodeSampleData(s));
  let totalSampleBytes = 0;
  for (const d of sampleData) totalSampleBytes += d.byteLength;
  const numSamples = inst.samples.length;
  const sampleHeadersBytes = numSamples * SAMPLE_HEADER_SIZE;
  const total =
    INSTRUMENT_HEADER_SIZE_FULL + sampleHeadersBytes + totalSampleBytes;
  const out = new Uint8Array(total);

  writeU32LE(out, 0, INSTRUMENT_HEADER_SIZE_FULL);
  writeAsciiPadded(out, 4, 22, inst.name);
  out[26] = 0;
  writeU16LE(out, 27, numSamples);
  // Extended block.
  writeU32LE(out, 29, SAMPLE_HEADER_SIZE);
  writeKeyMap(out, 33, inst.keyMap);
  writeEnvelopePoints(out, 129, inst.volumeEnvelope.points, 12);
  writeEnvelopePoints(out, 177, inst.panningEnvelope.points, 12);
  writeU8(out, 225, inst.volumeEnvelope.points.length);
  writeU8(out, 226, inst.panningEnvelope.points.length);
  writeU8(out, 227, inst.volumeEnvelope.sustainPoint);
  writeU8(out, 228, inst.volumeEnvelope.loopStart);
  writeU8(out, 229, inst.volumeEnvelope.loopEnd);
  writeU8(out, 230, inst.panningEnvelope.sustainPoint);
  writeU8(out, 231, inst.panningEnvelope.loopStart);
  writeU8(out, 232, inst.panningEnvelope.loopEnd);
  writeU8(out, 233, envelopeTypeBits(inst.volumeEnvelope));
  writeU8(out, 234, envelopeTypeBits(inst.panningEnvelope));
  writeU8(out, 235, encodeVibratoType(inst.vibratoType));
  writeU8(out, 236, inst.vibratoSweep);
  writeU8(out, 237, inst.vibratoDepth);
  writeU8(out, 238, inst.vibratoRate);
  writeU16LE(out, 239, inst.fadeout);
  // 22 bytes reserved at 241..262 stay zero.

  // Sample headers.
  let off = INSTRUMENT_HEADER_SIZE_FULL;
  for (let s = 0; s < numSamples; s++) {
    const sample = inst.samples[s]!;
    const data = sampleData[s]!;
    const is16 = sample.bits === 16;
    const lengthBytes = data.byteLength;
    const loopStartBytes = is16 ? sample.loopStart * 2 : sample.loopStart;
    const loopLengthBytes = is16 ? sample.loopLength * 2 : sample.loopLength;
    writeU32LE(out, off, lengthBytes);
    writeU32LE(out, off + 4, loopStartBytes);
    writeU32LE(out, off + 8, loopLengthBytes);
    writeU8(out, off + 12, sample.volume);
    writeI8(out, off + 13, sample.finetune);
    writeU8(out, off + 14, encodeSampleTypeBits(sample));
    writeU8(out, off + 15, sample.panning);
    writeI8(out, off + 16, sample.relativeNote);
    writeU8(out, off + 17, 0);
    writeAsciiPadded(out, off + 18, 22, sample.name);
    off += SAMPLE_HEADER_SIZE;
  }

  // Sample data.
  for (const d of sampleData) {
    out.set(d, off);
    off += d.byteLength;
  }

  return out;
}

function encodeSampleData(s: XmSample): Uint8Array {
  if (s.bits === 16) {
    if (!(s.data instanceof Int16Array)) {
      throw new Error("XM 16-bit sample's data must be Int16Array");
    }
    return deltaEncode16(s.data);
  }
  if (!(s.data instanceof Int8Array)) {
    throw new Error("XM 8-bit sample's data must be Int8Array");
  }
  return deltaEncode8(s.data);
}

function encodeSampleTypeBits(s: XmSample): number {
  let bits = 0;
  if (s.loopType === "forward") bits |= 0x01;
  else if (s.loopType === "ping-pong") bits |= 0x02;
  if (s.bits === 16) bits |= 0x10;
  return bits;
}

function writeEnvelopePoints(
  out: Uint8Array,
  off: number,
  points: XmEnvelope["points"],
  capacity: number,
): void {
  for (let i = 0; i < capacity; i++) {
    const p = points[i];
    if (p) {
      writeU16LE(out, off + i * 4, p.tick);
      writeU16LE(out, off + i * 4 + 2, p.value);
    } else {
      writeU16LE(out, off + i * 4, 0);
      writeU16LE(out, off + i * 4 + 2, 0);
    }
  }
}

function envelopeTypeBits(env: XmEnvelope): number {
  let bits = 0;
  if (env.enabled) bits |= 0x01;
  if (env.sustainEnabled) bits |= 0x02;
  if (env.loopEnabled) bits |= 0x04;
  return bits;
}

function encodeVibratoType(t: XmInstrument["vibratoType"]): number {
  switch (t) {
    case "square":
      return 1;
    case "ramp-down":
      return 2;
    case "ramp-up":
      return 3;
    default:
      return 0;
  }
}
