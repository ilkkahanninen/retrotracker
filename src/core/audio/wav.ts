/**
 * Minimal RIFF/WAV PCM reader + writer.
 *
 * Reader supports 8/16/24-bit integer PCM and 32-bit float PCM, mono or
 * stereo. Writer emits 16/24-bit integer PCM. Anything outside that throws.
 *
 * Used by the offline-render test bed (writing reference WAVs and reading
 * them back) and by the runtime sample importer (converting user-loaded
 * WAVs into ProTracker 8-bit signed mono samples).
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
  if (numChannels < 1 || numChannels > 2) throw new Error(`Unsupported channel count: ${numChannels}`);

  // Format 1 = PCM int, 3 = IEEE float, 0xFFFE = WAVE_FORMAT_EXTENSIBLE.
  // Extensible carries a sub-format GUID; for sample loading we just trust
  // the bit depth and treat int/float by depth alone.
  const isFloat = audioFormat === 3;
  if (audioFormat !== 1 && audioFormat !== 3 && audioFormat !== 0xFFFE) {
    throw new Error(`Unsupported WAV format: ${audioFormat} (need PCM int or float)`);
  }
  if (isFloat && bitsPerSample !== 32) {
    throw new Error(`Unsupported float bit depth: ${bitsPerSample}`);
  }
  if (!isFloat && bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24) {
    throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * numChannels));
  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frames));

  if (bitsPerSample === 8) {
    // 8-bit WAV is UNSIGNED — 128 is silence.
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = u8[dataOff + i * numChannels + c]!;
        channels[c]![i] = (s - 128) / 128;
      }
    }
  } else if (bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = view.getInt16(dataOff + (i * numChannels + c) * 2, true);
        channels[c]![i] = s / 32768;
      }
    }
  } else if (bitsPerSample === 24) {
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
  } else {
    // 32-bit float.
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        channels[c]![i] = view.getFloat32(dataOff + (i * numChannels + c) * 4, true);
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
