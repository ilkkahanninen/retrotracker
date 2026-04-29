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
