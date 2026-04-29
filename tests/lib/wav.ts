/**
 * Minimal RIFF/WAV PCM reader + writer.
 * Supports 16-bit and 24-bit PCM, mono or stereo. Anything else throws.
 */

export interface WavData {
  sampleRate: number;
  /** One Float32Array per channel, normalized to [-1, 1]. */
  channels: Float32Array[];
}

export function readWav(buf: ArrayBufferLike | Uint8Array): WavData {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (readAscii(u8, 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (readAscii(u8, 8, 4) !== 'WAVE') throw new Error('Not a WAVE file');

  let off = 12;
  let fmtFound = false;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  let dataOff = -1;
  let dataLen = 0;

  while (off + 8 <= u8.byteLength) {
    const chunkId = readAscii(u8, off, 4);
    const chunkSize = view.getUint32(off + 4, true);
    const body = off + 8;
    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      fmtFound = true;
    } else if (chunkId === 'data') {
      dataOff = body;
      dataLen = chunkSize;
      break;
    }
    off = body + chunkSize + (chunkSize & 1); // pad to even
  }

  if (!fmtFound) throw new Error('WAV missing fmt chunk');
  if (dataOff < 0) throw new Error('WAV missing data chunk');
  if (audioFormat !== 1) throw new Error(`Unsupported WAV format: ${audioFormat} (need PCM)`);
  if (numChannels < 1 || numChannels > 2) throw new Error(`Unsupported channel count: ${numChannels}`);
  if (bitsPerSample !== 16 && bitsPerSample !== 24) {
    throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * numChannels));
  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frames));

  if (bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = view.getInt16(dataOff + (i * numChannels + c) * 2, true);
        channels[c]![i] = s / 32768;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const o = dataOff + (i * numChannels + c) * 3;
        const lo = u8[o]!;
        const mi = u8[o + 1]!;
        const hi = u8[o + 2]!;
        let s = (hi << 16) | (mi << 8) | lo;
        if (s & 0x800000) s -= 0x1000000;
        channels[c]![i] = s / 8388608;
      }
    }
  }

  return { sampleRate, channels };
}

export interface WriteWavOptions {
  bitsPerSample?: 16 | 24;
}

export function writeWav(data: WavData, opts: WriteWavOptions = {}): Uint8Array {
  const bps = opts.bitsPerSample ?? 16;
  const nch = data.channels.length;
  if (nch < 1) throw new Error('Need at least one channel');
  const frames = data.channels[0]!.length;
  for (const ch of data.channels) {
    if (ch.length !== frames) throw new Error('Channels must have equal length');
  }
  const bytesPerSample = bps / 8;
  const dataLen = frames * nch * bytesPerSample;
  const total = 44 + dataLen;
  const u8 = new Uint8Array(total);
  const view = new DataView(u8.buffer);
  writeAscii(u8, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeAscii(u8, 8, 'WAVE');
  writeAscii(u8, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, nch, true);
  view.setUint32(24, data.sampleRate, true);
  view.setUint32(28, data.sampleRate * nch * bytesPerSample, true);
  view.setUint16(32, nch * bytesPerSample, true);
  view.setUint16(34, bps, true);
  writeAscii(u8, 36, 'data');
  view.setUint32(40, dataLen, true);

  let off = 44;
  if (bps === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        const v = clamp(data.channels[c]![i]!, -1, 1);
        view.setInt16(off, Math.round(v * 32767), true);
        off += 2;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        const v = clamp(data.channels[c]![i]!, -1, 1);
        const s = Math.round(v * 8388607);
        u8[off] = s & 0xff;
        u8[off + 1] = (s >> 8) & 0xff;
        u8[off + 2] = (s >> 16) & 0xff;
        off += 3;
      }
    }
  }
  return u8;
}

function readAscii(u8: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]!);
  return s;
}

function writeAscii(u8: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
