/**
 * XM stores sample data delta-encoded: each output sample is the difference
 * from the previous one, so a long held tone compresses well even though
 * the file isn't otherwise compressed. The first sample's "previous" is 0.
 *
 * 8-bit samples: signed bytes (-128..127), wrap modulo 256.
 * 16-bit samples: signed shorts (-32768..32767), little-endian on disk,
 * wrap modulo 65536.
 */

export function deltaDecode8(bytes: Uint8Array): Int8Array {
  const out = new Int8Array(bytes.length);
  let prev = 0;
  for (let i = 0; i < bytes.length; i++) {
    // bytes[i] is unsigned; reading into Int8Array re-interprets the
    // resulting low byte as signed for free.
    prev = (prev + bytes[i]!) & 0xff;
    out[i] = prev > 0x7f ? prev - 0x100 : prev;
  }
  return out;
}

export function deltaEncode8(samples: Int8Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i]! & 0xff;
    out[i] = (cur - prev) & 0xff;
    prev = cur;
  }
  return out;
}

/** Decode `byteLength` bytes of 16-bit LE delta-encoded samples. */
export function deltaDecode16(bytes: Uint8Array): Int16Array {
  const sampleCount = bytes.length >>> 1;
  const out = new Int16Array(sampleCount);
  let prev = 0;
  for (let i = 0; i < sampleCount; i++) {
    const lo = bytes[i * 2]!;
    const hi = bytes[i * 2 + 1]!;
    const delta = lo | (hi << 8);
    prev = (prev + delta) & 0xffff;
    out[i] = prev > 0x7fff ? prev - 0x10000 : prev;
  }
  return out;
}

export function deltaEncode16(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i]! & 0xffff;
    const delta = (cur - prev) & 0xffff;
    out[i * 2] = delta & 0xff;
    out[i * 2 + 1] = (delta >>> 8) & 0xff;
    prev = cur;
  }
  return out;
}
