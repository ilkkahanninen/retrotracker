/**
 * Programmatic fixture generator.
 *
 * Each fixture is a minimal strict-M.K. module that exercises ONE replayer
 * behavior. Pair the output with a pt2-clone reference render to drive the
 * accuracy test bed (see ./README.md).
 *
 * Usage: `npm run fixtures:generate`
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeModule } from '../../src/core/mod/writer';
import {
  emptyPattern,
  emptySample,
  emptySong,
  PERIOD_TABLE,
} from '../../src/core/mod/format';
import type { Note, Pattern, Sample, Song } from '../../src/core/mod/types';

// ─── Sample synthesis ──────────────────────────────────────────────────────

/** Triangle wave, peak ±100 (leaves headroom). `words` × 2 bytes. */
function triangleSample(words: number, peak = 100): Int8Array {
  const len = words * 2;
  const data = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    const phase = i / len; // 0..1
    const v = phase < 0.5 ? -peak + phase * 4 * peak : peak - (phase - 0.5) * 4 * peak;
    data[i] = Math.round(v);
  }
  return data;
}

/** Square wave, ±peak, 50% duty. */
function squareSample(words: number, peak = 80): Int8Array {
  const len = words * 2;
  const data = new Int8Array(len);
  for (let i = 0; i < len; i++) data[i] = i < len / 2 ? peak : -peak;
  return data;
}

/** Single-cycle sine, ±peak. */
function sineSample(words: number, peak = 100): Int8Array {
  const len = words * 2;
  const data = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    data[i] = Math.round(Math.sin((i / len) * 2 * Math.PI) * peak);
  }
  return data;
}

// ─── Note helpers ──────────────────────────────────────────────────────────

const NOTE_OFFSET: Record<string, number> = {
  'C-': 0, 'C#': 1, 'D-': 2, 'D#': 3, 'E-': 4, 'F-': 5,
  'F#': 6, 'G-': 7, 'G#': 8, 'A-': 9, 'A#': 10, 'B-': 11,
};

/** Look up a finetune-0 period by name like 'C-2', 'F#3'. */
function periodOf(name: string): number {
  if (name.length !== 3) throw new Error(`bad note: "${name}"`);
  const noteName = name.substring(0, 2);
  const octave = Number(name.substring(2));
  if (!Number.isInteger(octave) || octave < 1 || octave > 3) {
    throw new Error(`octave out of range: "${name}"`);
  }
  const off = NOTE_OFFSET[noteName];
  if (off === undefined) throw new Error(`bad note name: "${name}"`);
  return PERIOD_TABLE[0]![(octave - 1) * 12 + off]!;
}

interface CellSpec {
  note?: string;
  sample?: number;
  effect?: number;
  param?: number;
}

function cell(spec: CellSpec | undefined): Note {
  if (!spec) return { period: 0, sample: 0, effect: 0, effectParam: 0 };
  return {
    period: spec.note ? periodOf(spec.note) : 0,
    sample: spec.sample ?? 0,
    effect: spec.effect ?? 0,
    effectParam: spec.param ?? 0,
  };
}

type RowSpec = (CellSpec | undefined)[];

function makePattern(rows: RowSpec[]): Pattern {
  const p = emptyPattern();
  for (let r = 0; r < rows.length && r < p.rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < 4; c++) p.rows[r]![c] = cell(row[c]);
  }
  return p;
}

interface SampleSpec extends Partial<Sample> {
  slot: number;
}

function makeSong(opts: {
  title: string;
  samples: SampleSpec[];
  patterns: Pattern[];
  orders?: number[];
}): Song {
  const song = emptySong();
  song.title = opts.title;
  for (const s of opts.samples) {
    const idx = s.slot - 1;
    const data = s.data ?? new Int8Array(0);
    song.samples[idx] = {
      ...emptySample(),
      ...s,
      data,
      lengthWords: Math.floor(data.byteLength / 2),
    };
  }
  song.patterns = opts.patterns;
  const orders = opts.orders ?? opts.patterns.map((_, i) => i);
  for (let i = 0; i < orders.length; i++) song.orders[i] = orders[i]!;
  song.songLength = orders.length;
  return song;
}

// ─── Shared sample data ────────────────────────────────────────────────────

const TRI = triangleSample(32); // 64 bytes, looped
const SQR = squareSample(32);
const SIN = sineSample(32);

const triLooped: SampleSpec = {
  slot: 1,
  name: 'triangle',
  data: TRI,
  volume: 64,
  finetune: 0,
  loopStartWords: 0,
  loopLengthWords: 32,
};

const sqrLooped: SampleSpec = {
  slot: 2,
  name: 'square',
  data: SQR,
  volume: 64,
  finetune: 0,
  loopStartWords: 0,
  loopLengthWords: 32,
};

const sinLooped: SampleSpec = {
  slot: 3,
  name: 'sine',
  data: SIN,
  volume: 64,
  finetune: 0,
  loopStartWords: 0,
  loopLengthWords: 32,
};

// ─── Fixture builders ──────────────────────────────────────────────────────

/**
 * 00-baseline — 4 sustained notes, no effects. The smallest possible test:
 * if this differs significantly from pt2-clone, the resampler / period
 * handling is fundamentally off, not just a missing effect.
 */
function fixtureBaseline(): Song {
  const rows: RowSpec[] = [];
  const notes = ['C-2', 'E-2', 'G-2', 'C-3'];
  for (let i = 0; i < 64; i++) {
    if (i % 16 === 0) rows.push([{ note: notes[i / 16]!, sample: 1 }]);
    else rows.push([]);
  }
  return makeSong({
    title: 'baseline',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 01-resampling — chromatic scale on a square wave. Each pitch hits a
 * different output-sample step ratio, exposing aliasing differences
 * between linear interpolation and BLEP resampling.
 */
function fixtureResampling(): Song {
  const scale: string[] = [];
  for (let oct = 1; oct <= 3; oct++) {
    for (const n of ['C-', 'D-', 'E-', 'F-', 'G-', 'A-', 'B-']) {
      scale.push(`${n}${oct}`);
    }
  }
  // 21 notes; 3 rows each = 63 rows, fits a pattern.
  const rows: RowSpec[] = [];
  for (let i = 0; i < 64; i++) {
    if (i < scale.length * 3 && i % 3 === 0) {
      rows.push([{ note: scale[i / 3]!, sample: 2 }]);
    } else {
      rows.push([]);
    }
  }
  return makeSong({
    title: 'resampling',
    samples: [sqrLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 02-amiga-filter — alternate E01 (filter on) and E00 (filter off) on a
 * sustained square-wave note. The Amiga LED filter is a low-pass around
 * 3.3 kHz; toggling should audibly soften and re-brighten the harmonics.
 */
function fixtureAmigaFilter(): Song {
  const rows: RowSpec[] = [];
  // Trigger a sustained note on row 0
  rows.push([{ note: 'C-3', sample: 2 }]);
  for (let i = 1; i < 64; i++) {
    if (i === 8)  rows.push([{ effect: 0xE, param: 0x01 }]); // filter on
    else if (i === 24) rows.push([{ effect: 0xE, param: 0x00 }]); // filter off
    else if (i === 40) rows.push([{ effect: 0xE, param: 0x01 }]); // on
    else if (i === 56) rows.push([{ effect: 0xE, param: 0x00 }]); // off
    else rows.push([]);
  }
  return makeSong({
    title: 'amiga-filter',
    samples: [sqrLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 03-vibrato-waveforms — vibrato at 4xy with E4y waveform changes mid-note.
 * E40 = sine (default), E41 = ramp down, E42 = square, E43 = random.
 */
function fixtureVibratoWaveforms(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-3', sample: 1, effect: 0xE, param: 0x40 }]; // sine
  for (let i = 1; i < 16; i++) rows[i] = [{ effect: 0x4, param: 0x44 }];
  rows[16] = [{ effect: 0xE, param: 0x41 }]; // ramp
  for (let i = 17; i < 32; i++) rows[i] = [{ effect: 0x4, param: 0x44 }];
  rows[32] = [{ effect: 0xE, param: 0x42 }]; // square
  for (let i = 33; i < 48; i++) rows[i] = [{ effect: 0x4, param: 0x44 }];
  rows[48] = [{ effect: 0xE, param: 0x43 }]; // random
  for (let i = 49; i < 64; i++) rows[i] = [{ effect: 0x4, param: 0x44 }];
  return makeSong({
    title: 'vibrato-waveforms',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 04-tremolo-waveforms — same shape as 03 but with 7xy and E7y.
 */
function fixtureTremoloWaveforms(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-3', sample: 1, effect: 0xE, param: 0x70 }]; // sine
  for (let i = 1; i < 16; i++) rows[i] = [{ effect: 0x7, param: 0x44 }];
  rows[16] = [{ effect: 0xE, param: 0x71 }]; // ramp
  for (let i = 17; i < 32; i++) rows[i] = [{ effect: 0x7, param: 0x44 }];
  rows[32] = [{ effect: 0xE, param: 0x72 }]; // square
  for (let i = 33; i < 48; i++) rows[i] = [{ effect: 0x7, param: 0x44 }];
  rows[48] = [{ effect: 0xE, param: 0x73 }]; // random
  for (let i = 49; i < 64; i++) rows[i] = [{ effect: 0x7, param: 0x44 }];
  return makeSong({
    title: 'tremolo-waveforms',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 05-glissando — same tone-portamento twice: first without glissando (smooth
 * slide), then with E31 (steps in semitones). The two halves should sound
 * identical to a player that ignores E3y and noticeably different to one
 * that honors it.
 */
function fixtureGlissando(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  // Half 1: smooth tone porta (E30 = off)
  rows[0]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x30 }];
  rows[8]  = [{ note: 'G-2', effect: 0x3, param: 0x08 }];
  for (let i = 9; i < 32; i++) rows[i] = [{ effect: 0x3, param: 0x00 }];
  // Half 2: glissando on
  rows[32] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x31 }];
  rows[40] = [{ note: 'G-2', effect: 0x3, param: 0x08 }];
  for (let i = 41; i < 64; i++) rows[i] = [{ effect: 0x3, param: 0x00 }];
  return makeSong({
    title: 'glissando',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 06-panning — 8xy on each channel at varying values: 00 (left), 40, 80
 * (center), C0, FF (right). PT 2.3D ignores 8xy; the test pins down that
 * we likewise ignore it. Sound mono if both ends honor "ignore".
 */
function fixturePanning(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-3', sample: 1, effect: 0x8, param: 0x00 },
              { note: 'E-3', sample: 1, effect: 0x8, param: 0x40 },
              { note: 'G-3', sample: 1, effect: 0x8, param: 0xC0 },
              { note: 'C-3', sample: 1, effect: 0x8, param: 0xFF }];
  rows[16] = [{ effect: 0x8, param: 0xFF },
              { effect: 0x8, param: 0xC0 },
              { effect: 0x8, param: 0x40 },
              { effect: 0x8, param: 0x00 }];
  return makeSong({
    title: 'panning',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 07-invert-loop — sustained looped sample with EFy commands at varying
 * speeds. Off (EF0), slow (EF4), fast (EFF). Audible only if the player
 * implements byte-flipping on the active loop region.
 */
function fixtureInvertLoop(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-3', sample: 1 }];
  rows[8]  = [{ effect: 0xE, param: 0xF1 }];
  rows[24] = [{ effect: 0xE, param: 0xF8 }];
  rows[40] = [{ effect: 0xE, param: 0xFF }];
  rows[56] = [{ effect: 0xE, param: 0xF0 }]; // off
  return makeSong({
    title: 'invert-loop',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 08-arpeggio — sustained note with major/minor/octave arpeggios at 0xy. */
function fixtureArpeggio(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-2', sample: 1 }];
  // Major triad: +4, +7
  for (let i = 4; i < 16; i++) rows[i] = [{ effect: 0x0, param: 0x47 }];
  // Minor triad: +3, +7
  for (let i = 20; i < 32; i++) rows[i] = [{ effect: 0x0, param: 0x37 }];
  // Octave: +12 = 0x0C
  for (let i = 36; i < 48; i++) rows[i] = [{ effect: 0x0, param: 0x0C }];
  // Suspended fifth: +5 only
  for (let i = 52; i < 60; i++) rows[i] = [{ effect: 0x0, param: 0x05 }];
  return makeSong({
    title: 'arpeggio',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 09-slide-up — sustained note with slide-up (1xx) at varying speeds. */
function fixtureSlideUp(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-2', sample: 1 }];
  for (let i = 4; i < 12; i++) rows[i] = [{ effect: 0x1, param: 0x02 }];
  for (let i = 16; i < 24; i++) rows[i] = [{ effect: 0x1, param: 0x08 }];
  rows[28] = [{ note: 'C-2', sample: 1 }];
  for (let i = 32; i < 48; i++) rows[i] = [{ effect: 0x1, param: 0x10 }];
  return makeSong({
    title: 'slide-up',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 10-slide-down — sustained note with slide-down (2xx) at varying speeds. */
function fixtureSlideDown(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-3', sample: 1 }];
  for (let i = 4; i < 12; i++) rows[i] = [{ effect: 0x2, param: 0x02 }];
  for (let i = 16; i < 24; i++) rows[i] = [{ effect: 0x2, param: 0x08 }];
  rows[28] = [{ note: 'C-3', sample: 1 }];
  for (let i = 32; i < 48; i++) rows[i] = [{ effect: 0x2, param: 0x10 }];
  return makeSong({
    title: 'slide-down',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 11-tone-porta-vol-slide — 3xx target then 5xy continues with vol slide. */
function fixtureTonePortaVolSlide(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-2', sample: 1 }];
  rows[4] = [{ note: 'G-2', effect: 0x3, param: 0x08 }];
  for (let i = 5; i < 12; i++) rows[i] = [{ effect: 0x3, param: 0x00 }];
  for (let i = 12; i < 20; i++) rows[i] = [{ effect: 0x5, param: 0x40 }]; // vol up + porta
  for (let i = 20; i < 28; i++) rows[i] = [{ effect: 0x5, param: 0x04 }]; // vol down + porta
  rows[32] = [{ note: 'C-3', effect: 0x3, param: 0x10 }];
  for (let i = 33; i < 40; i++) rows[i] = [{ effect: 0x3, param: 0x00 }];
  for (let i = 40; i < 48; i++) rows[i] = [{ effect: 0x5, param: 0x08 }];
  return makeSong({
    title: 'tone-porta-vol-slide',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 12-vibrato-vol-slide — 4xy vibrato then 6xy continues with vol slide. */
function fixtureVibratoVolSlide(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-3', sample: 1, effect: 0x4, param: 0x46 }];
  for (let i = 1; i < 8; i++) rows[i] = [{ effect: 0x4, param: 0x00 }];
  for (let i = 8; i < 16; i++) rows[i] = [{ effect: 0x6, param: 0x40 }]; // vol up + vib
  for (let i = 16; i < 24; i++) rows[i] = [{ effect: 0x6, param: 0x04 }]; // vol down + vib
  for (let i = 24; i < 40; i++) rows[i] = [{ effect: 0x4, param: 0x00 }]; // vib alone
  for (let i = 40; i < 48; i++) rows[i] = [{ effect: 0x6, param: 0x80 }]; // vol up faster
  return makeSong({
    title: 'vibrato-vol-slide',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 13-sample-offset — long looped triangle, retriggered with various 9xx
 * offsets. Each retrigger starts at a different phase and the wave loops
 * through the full sample.
 */
function fixtureSampleOffset(): Song {
  const triLong: SampleSpec = {
    slot: 1,
    name: 'tri-long',
    data: triangleSample(512), // 1024 bytes
    volume: 64,
    finetune: 0,
    loopStartWords: 0,
    loopLengthWords: 512,
  };
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[16] = [{ note: 'C-2', sample: 1, effect: 0x9, param: 0x01 }]; // offset 256
  rows[32] = [{ note: 'C-2', sample: 1, effect: 0x9, param: 0x02 }]; // offset 512
  rows[48] = [{ note: 'C-2', sample: 1, effect: 0x9, param: 0x03 }]; // offset 768
  return makeSong({
    title: 'sample-offset',
    samples: [triLong],
    patterns: [makePattern(rows)],
  });
}

/** 14-volume-slide — sustained note with Axx slides up and down. */
function fixtureVolumeSlide(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0] = [{ note: 'C-2', sample: 1 }];
  for (let i = 4; i < 12; i++) rows[i] = [{ effect: 0xA, param: 0x04 }]; // down 4
  for (let i = 16; i < 24; i++) rows[i] = [{ effect: 0xA, param: 0x40 }]; // up 4
  for (let i = 28; i < 36; i++) rows[i] = [{ effect: 0xA, param: 0x08 }]; // down 8
  for (let i = 40; i < 48; i++) rows[i] = [{ effect: 0xA, param: 0x80 }]; // up 8
  for (let i = 52; i < 60; i++) rows[i] = [{ effect: 0xA, param: 0x0F }]; // down 15
  return makeSong({
    title: 'volume-slide',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 15-position-jump — Bxx between two patterns. Pat 0 jumps to order 1,
 * pat 1 jumps back to order 0; song-end detection fires on the second
 * revisit of (order 1, row 0).
 */
function fixturePositionJump(): Song {
  const pat0: RowSpec[] = new Array(64).fill(0).map(() => []);
  pat0[0]  = [{ note: 'C-2', sample: 1 }];
  pat0[8]  = [{ note: 'E-2', sample: 1 }];
  pat0[16] = [{ note: 'G-2', sample: 1 }];
  pat0[32] = [{ effect: 0xB, param: 0x01 }];
  const pat1: RowSpec[] = new Array(64).fill(0).map(() => []);
  pat1[0]  = [{ note: 'C-3', sample: 1 }];
  pat1[8]  = [{ note: 'E-3', sample: 1 }];
  pat1[16] = [{ effect: 0xB, param: 0x00 }];
  return makeSong({
    title: 'position-jump',
    samples: [triLooped],
    patterns: [makePattern(pat0), makePattern(pat1)],
  });
}

/** 16-set-volume — sustained note with various Cxx volume sets. */
function fixtureSetVolume(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[8]  = [{ effect: 0xC, param: 0x20 }]; // 32
  rows[16] = [{ effect: 0xC, param: 0x10 }]; // 16
  rows[24] = [{ effect: 0xC, param: 0x00 }]; // silence
  rows[32] = [{ note: 'C-2', sample: 1, effect: 0xC, param: 0x40 }]; // re-trigger full
  rows[40] = [{ effect: 0xC, param: 0x30 }];
  rows[48] = [{ effect: 0xC, param: 0x60 }]; // clamp to 64
  rows[56] = [{ effect: 0xC, param: 0x08 }];
  return makeSong({
    title: 'set-volume',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 17-pattern-break — Dxx mid-pattern; orders=[0,0] so the second pass
 * starts at the break target and runs to song end.
 */
function fixturePatternBreak(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[8]  = [{ note: 'E-2', sample: 1 }];
  rows[16] = [{ note: 'G-2', sample: 1 }];
  rows[24] = [{ effect: 0xD, param: 0x10 }]; // break to row 10 (decimal)
  rows[32] = [{ note: 'C-3', sample: 1 }];   // skipped on first pass
  rows[40] = [{ note: 'E-3', sample: 1 }];
  return makeSong({
    title: 'pattern-break',
    samples: [triLooped],
    patterns: [makePattern(rows)],
    orders: [0, 0],
  });
}

/** 18-set-speed — Fxx speed and tempo changes. */
function fixtureSetSpeed(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[8]  = [{ effect: 0xF, param: 0x03 }]; // speed 3
  rows[16] = [{ note: 'E-2', sample: 1 }];
  rows[24] = [{ effect: 0xF, param: 0x06 }]; // speed 6
  rows[32] = [{ effect: 0xF, param: 0x40 }]; // tempo 64
  rows[40] = [{ note: 'G-2', sample: 1 }];
  rows[48] = [{ effect: 0xF, param: 0x7D }]; // tempo 125
  rows[56] = [{ note: 'C-3', sample: 1 }];
  return makeSong({
    title: 'set-speed',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 19-fine-slide-up — E1y at varying y. */
function fixtureFineSlideUp(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[4]  = [{ effect: 0xE, param: 0x11 }];
  rows[8]  = [{ effect: 0xE, param: 0x12 }];
  rows[12] = [{ effect: 0xE, param: 0x14 }];
  rows[16] = [{ effect: 0xE, param: 0x18 }];
  rows[20] = [{ effect: 0xE, param: 0x1F }];
  rows[28] = [{ note: 'C-2', sample: 1 }];
  for (let i = 32; i < 60; i += 2) rows[i] = [{ effect: 0xE, param: 0x12 }];
  return makeSong({
    title: 'fine-slide-up',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 20-fine-slide-down — E2y at varying y. */
function fixtureFineSlideDown(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-3', sample: 1 }];
  rows[4]  = [{ effect: 0xE, param: 0x21 }];
  rows[8]  = [{ effect: 0xE, param: 0x22 }];
  rows[12] = [{ effect: 0xE, param: 0x24 }];
  rows[16] = [{ effect: 0xE, param: 0x28 }];
  rows[20] = [{ effect: 0xE, param: 0x2F }];
  rows[28] = [{ note: 'C-3', sample: 1 }];
  for (let i = 32; i < 60; i += 2) rows[i] = [{ effect: 0xE, param: 0x22 }];
  return makeSong({
    title: 'fine-slide-down',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 21-set-finetune — same C-2 retriggered with each E5y value. Pitch shifts
 * subtly each row; correctness requires E5y to be applied BEFORE the period
 * lookup (pt2-clone playVoice ordering).
 */
function fixtureSetFinetune(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x50 }];
  rows[8]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x51 }];
  rows[16] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x53 }];
  rows[24] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x57 }]; // +7
  rows[32] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x58 }]; // -8
  rows[40] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x5C }]; // -4
  rows[48] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x5F }]; // -1
  rows[56] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0x50 }];
  return makeSong({
    title: 'set-finetune',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 22-pattern-loop — E60 marks loop start, E62 loops back twice (segment
 * plays 3×). Tests both loopRow capture and the visited-set clear that
 * keeps song-end from tripping.
 */
function fixturePatternLoop(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[8]  = [{ effect: 0xE, param: 0x60 }];
  rows[16] = [{ note: 'E-2', sample: 1 }];
  rows[24] = [{ note: 'G-2', sample: 1 }];
  rows[32] = [{ effect: 0xE, param: 0x62 }];
  rows[48] = [{ note: 'C-3', sample: 1 }];
  return makeSong({
    title: 'pattern-loop',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 23-retrigger — sustained note with E9y at varying intervals. */
function fixtureRetrigger(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  for (let i = 4; i < 12; i++) rows[i] = [{ effect: 0xE, param: 0x94 }]; // every 4 ticks
  for (let i = 16; i < 24; i++) rows[i] = [{ effect: 0xE, param: 0x92 }]; // every 2 ticks
  for (let i = 28; i < 36; i++) rows[i] = [{ effect: 0xE, param: 0x91 }]; // every tick
  for (let i = 40; i < 48; i++) rows[i] = [{ effect: 0xE, param: 0x96 }]; // every 6 ticks
  for (let i = 52; i < 60; i++) rows[i] = [{ effect: 0xE, param: 0x93 }];
  return makeSong({
    title: 'retrigger',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 24-fine-vol-up — EAy fine volume up after starting low (Cxx). */
function fixtureFineVolUp(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1, effect: 0xC, param: 0x10 }]; // start at 16
  rows[4]  = [{ effect: 0xE, param: 0xA2 }];
  rows[8]  = [{ effect: 0xE, param: 0xA4 }];
  rows[12] = [{ effect: 0xE, param: 0xA8 }];
  rows[16] = [{ effect: 0xE, param: 0xAF }]; // up 15, clamps to 64
  rows[24] = [{ note: 'C-2', sample: 1, effect: 0xC, param: 0x08 }]; // restart at 8
  for (let i = 28; i < 56; i += 4) rows[i] = [{ effect: 0xE, param: 0xA4 }];
  return makeSong({
    title: 'fine-vol-up',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/** 25-fine-vol-down — EBy fine volume down from full. */
function fixtureFineVolDown(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[4]  = [{ effect: 0xE, param: 0xB2 }];
  rows[8]  = [{ effect: 0xE, param: 0xB4 }];
  rows[12] = [{ effect: 0xE, param: 0xB8 }];
  rows[16] = [{ effect: 0xE, param: 0xBF }]; // down 15, clamps to 0
  rows[24] = [{ note: 'C-2', sample: 1 }];   // re-trigger
  for (let i = 28; i < 56; i += 4) rows[i] = [{ effect: 0xE, param: 0xB4 }];
  return makeSong({
    title: 'fine-vol-down',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 26-note-cut — ECy cuts the note y ticks into the row by zeroing volume.
 * Each row triggers the same note with a different cut position.
 */
function fixtureNoteCut(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xC2 }];
  rows[8]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xC4 }];
  rows[16] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xC1 }];
  rows[24] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xC5 }];
  rows[32] = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xC0 }]; // cut at tick 0
  rows[40] = [{ note: 'C-2', sample: 1 }]; // no cut
  return makeSong({
    title: 'note-cut',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 27-note-delay — EDy delays the trigger by y ticks. Each row triggers a
 * different note with a different delay.
 */
function fixtureNoteDelay(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1, effect: 0xE, param: 0xD0 }]; // no delay
  rows[8]  = [{ note: 'E-2', sample: 1, effect: 0xE, param: 0xD2 }];
  rows[16] = [{ note: 'G-2', sample: 1, effect: 0xE, param: 0xD4 }];
  rows[24] = [{ note: 'C-3', sample: 1, effect: 0xE, param: 0xD5 }];
  rows[32] = [{ note: 'E-3', sample: 1, effect: 0xE, param: 0xD3 }];
  rows[40] = [{ note: 'G-3', sample: 1, effect: 0xE, param: 0xD1 }];
  return makeSong({
    title: 'note-delay',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

/**
 * 28-pattern-delay — EEy repeats the row's tick stream y times. Causes
 * sustained notes to extend by that many row-durations.
 */
function fixturePatternDelay(): Song {
  const rows: RowSpec[] = new Array(64).fill(0).map(() => []);
  rows[0]  = [{ note: 'C-2', sample: 1 }];
  rows[4]  = [{ note: 'E-2', sample: 1, effect: 0xE, param: 0xE3 }];
  rows[12] = [{ note: 'G-2', sample: 1, effect: 0xE, param: 0xE5 }];
  rows[24] = [{ note: 'C-3', sample: 1, effect: 0xE, param: 0xE2 }];
  rows[32] = [{ note: 'E-3', sample: 1 }];
  rows[40] = [{ note: 'G-3', sample: 1, effect: 0xE, param: 0xE1 }];
  return makeSong({
    title: 'pattern-delay',
    samples: [triLooped],
    patterns: [makePattern(rows)],
  });
}

// ─── Wire-up ───────────────────────────────────────────────────────────────

const FIXTURES: Record<string, () => Song> = {
  '00-baseline': fixtureBaseline,
  '01-resampling': fixtureResampling,
  '02-amiga-filter': fixtureAmigaFilter,
  '03-vibrato-waveforms': fixtureVibratoWaveforms,
  '04-tremolo-waveforms': fixtureTremoloWaveforms,
  '05-glissando': fixtureGlissando,
  '06-panning': fixturePanning,
  '07-invert-loop': fixtureInvertLoop,
  '08-arpeggio': fixtureArpeggio,
  '09-slide-up': fixtureSlideUp,
  '10-slide-down': fixtureSlideDown,
  '11-tone-porta-vol-slide': fixtureTonePortaVolSlide,
  '12-vibrato-vol-slide': fixtureVibratoVolSlide,
  '13-sample-offset': fixtureSampleOffset,
  '14-volume-slide': fixtureVolumeSlide,
  '15-position-jump': fixturePositionJump,
  '16-set-volume': fixtureSetVolume,
  '17-pattern-break': fixturePatternBreak,
  '18-set-speed': fixtureSetSpeed,
  '19-fine-slide-up': fixtureFineSlideUp,
  '20-fine-slide-down': fixtureFineSlideDown,
  '21-set-finetune': fixtureSetFinetune,
  '22-pattern-loop': fixturePatternLoop,
  '23-retrigger': fixtureRetrigger,
  '24-fine-vol-up': fixtureFineVolUp,
  '25-fine-vol-down': fixtureFineVolDown,
  '26-note-cut': fixtureNoteCut,
  '27-note-delay': fixtureNoteDelay,
  '28-pattern-delay': fixturePatternDelay,
};

function main(): void {
  const outDir = new URL('./', import.meta.url).pathname;
  for (const [name, build] of Object.entries(FIXTURES)) {
    const path = join(outDir, `${name}.mod`);
    const buf = writeModule(build());
    writeFileSync(path, buf);
    console.log(`wrote ${name}.mod (${buf.byteLength} bytes)`);
  }
}

main();
