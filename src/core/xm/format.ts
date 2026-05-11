import {
  XM_MAX_ENVELOPE_POINTS,
  XM_MAX_ORDERS,
  type XmEnvelope,
  type XmInstrument,
  type XmNote,
  type XmPattern,
  type XmSample,
  type XmSong,
} from "./types";

/** Default tracker name written when we save out a fresh project. */
export const XM_DEFAULT_TRACKER_NAME = "RetroTracker";
/** Canonical FT2 .xm version word. */
export const XM_VERSION = 0x0104;
/** Default speed (ticks/row) and BPM (FT2 defaults). */
export const XM_DEFAULT_SPEED = 6;
export const XM_DEFAULT_BPM = 125;
/** Channel count for newly created XM projects (Phase 1 fresh-song default). */
export const XM_DEFAULT_CHANNELS = 8;
/** Pattern row count for newly created patterns. */
export const XM_DEFAULT_PATTERN_ROWS = 64;

export function emptyXmNote(): XmNote {
  return { note: 0, instrument: 0, volumeColumn: 0, effect: 0, effectParam: 0 };
}

export function emptyXmPattern(rows: number, channels: number): XmPattern {
  const rs: XmNote[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row: XmNote[] = new Array(channels);
    for (let c = 0; c < channels; c++) row[c] = emptyXmNote();
    rs[r] = row;
  }
  return { rows: rs, rowCount: rows };
}

export function emptyXmEnvelope(): XmEnvelope {
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

export function emptyXmSample(): XmSample {
  return {
    name: "",
    data: new Int8Array(0),
    bits: 8,
    loopStart: 0,
    loopLength: 0,
    loopType: "none",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
}

export function emptyXmInstrument(): XmInstrument {
  return {
    name: "",
    samples: [emptyXmSample()],
    keyMap: new Uint8Array(96),
    volumeEnvelope: emptyXmEnvelope(),
    panningEnvelope: emptyXmEnvelope(),
    vibratoType: "sine",
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
    fadeout: 0,
  };
}

void XM_MAX_ENVELOPE_POINTS;

export function emptyXmSong(): XmSong {
  return {
    format: "FT2",
    title: "",
    trackerName: XM_DEFAULT_TRACKER_NAME,
    version: XM_VERSION,
    channelCount: XM_DEFAULT_CHANNELS,
    songLength: 1,
    restartPosition: 0,
    orders: new Array(XM_MAX_ORDERS).fill(0),
    patterns: [emptyXmPattern(XM_DEFAULT_PATTERN_ROWS, XM_DEFAULT_CHANNELS)],
    instruments: [],
    flags: { linearFreq: true },
    defaultTempo: XM_DEFAULT_SPEED,
    defaultBpm: XM_DEFAULT_BPM,
  };
}
