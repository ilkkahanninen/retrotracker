/**
 * Programmatic XM fixture generator.
 *
 * Each fixture is a minimal `.xm` module that exercises ONE replayer
 * behaviour. Pair the output with a libxmp reference render (the test
 * bed does that automatically via xmp-cli) to drive the accuracy bed.
 *
 * Usage: `npm run fixtures:generate-xm`
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptyXmInstrument,
  emptyXmPattern,
  emptyXmSong,
} from "../../../src/core/xm/format";
import { setXmCell, setXmInstrument } from "../../../src/core/xm/mutations";
import { writeXm } from "../../../src/core/xm/writer";
import type {
  XmInstrument,
  XmNote,
  XmSample,
  XmSong,
} from "../../../src/core/xm/types";

// ─── Sample synthesis ──────────────────────────────────────────────────────

function triangleSample(length: number, peak = 100): Int8Array {
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) {
    const phase = i / length;
    const v =
      phase < 0.5 ? -peak + phase * 4 * peak : peak - (phase - 0.5) * 4 * peak;
    data[i] = Math.round(v);
  }
  return data;
}

function squareSample(length: number, peak = 80): Int8Array {
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) data[i] = i < length / 2 ? peak : -peak;
  return data;
}

// ─── Builders ──────────────────────────────────────────────────────────────

function newSample(data: Int8Array, name: string): XmSample {
  return {
    name,
    data,
    bits: 8,
    loopStart: 0,
    loopLength: data.length,
    loopType: "forward",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
}

function newInstrument(samp: XmSample, name: string): XmInstrument {
  return {
    ...emptyXmInstrument(),
    name,
    samples: [samp],
  };
}

/**
 * Start from emptyXmSong but replace the order list and patterns array
 * with the supplied list. Order [0..patterns.length-1] one-to-one.
 */
function songWithPatterns(
  patterns: { rowCount: number; rows: XmNote[][] }[],
  channelCount = 4,
): XmSong {
  let s = emptyXmSong();
  s = { ...s, channelCount, songLength: patterns.length };
  // Resize the patterns to the requested channel count.
  const resized = patterns.map((p) => ({
    rowCount: p.rowCount,
    rows: p.rows.map((row) =>
      row.length === channelCount
        ? row
        : row.concat(
            Array.from({ length: channelCount - row.length }, () => ({
              note: 0,
              instrument: 0,
              volumeColumn: 0,
              effect: 0,
              effectParam: 0,
            })),
          ),
    ),
  }));
  s = { ...s, patterns: resized };
  s = { ...s, orders: [...s.orders] };
  for (let i = 0; i < patterns.length; i++) s.orders[i] = i;
  return s;
}

function emptyRow(channelCount: number): XmNote[] {
  return Array.from({ length: channelCount }, () => ({
    note: 0,
    instrument: 0,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
  }));
}

function emptyRows(rowCount: number, channelCount: number): XmNote[][] {
  return Array.from({ length: rowCount }, () => emptyRow(channelCount));
}

function cell(args: Partial<XmNote>): XmNote {
  return {
    note: 0,
    instrument: 0,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
    ...args,
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

/**
 * 00-baseline: a four-channel song with a single sustained note in
 * channel 0. No effects, no envelopes — the sanity anchor that
 * everything else builds on.
 */
function buildBaseline(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = {
    note: 49, // C-4
    instrument: 1,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
  };
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "baseline";
  return s;
}

/**
 * 01-volume-slide: full-volume note, then Axy slides volume up/down at
 * various speeds.
 */
function buildVolSlide(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = {
    note: 49,
    instrument: 1,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
  };
  // Slide down 4 per tick for 4 rows.
  for (let r = 1; r <= 4; r++) {
    pat.rows[r]![0] = {
      note: 0,
      instrument: 0,
      volumeColumn: 0,
      effect: 0x0a,
      effectParam: 0x04,
    };
  }
  // Slide up 8 per tick for 4 rows.
  for (let r = 5; r <= 8; r++) {
    pat.rows[r]![0] = {
      note: 0,
      instrument: 0,
      volumeColumn: 0,
      effect: 0x0a,
      effectParam: 0x80,
    };
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volslide";
  return s;
}

/**
 * 02-arpeggio: held note + 0xy arpeggio (major triad).
 */
function buildArpeggio(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = {
    note: 49,
    instrument: 1,
    volumeColumn: 0,
    effect: 0,
    effectParam: 0,
  };
  // 047 = major triad (root, +4 minor third, +7 fifth). Held for 16 rows.
  for (let r = 1; r <= 16; r++) {
    pat.rows[r]![0] = {
      note: 0,
      instrument: 0,
      volumeColumn: 0,
      effect: 0x00,
      effectParam: 0x47,
    };
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "arpeggio";
  return s;
}

/**
 * 03-retrigger: same note retriggered every 2 rows. Exercises libxmp's
 * `do_anticlick` discharge curve — the previous voice's tail sample
 * gets quadratically decayed over the ramp window on every new
 * trigger. If we're bit-perfect on a hammering retrigger fixture,
 * we've matched libxmp's discharge behaviour too.
 */
function buildRetrigger(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  for (let r = 0; r < 32; r += 2) {
    pat.rows[r]![0] = {
      note: 49,
      instrument: 1,
      volumeColumn: 0,
      effect: 0,
      effectParam: 0,
    };
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "retrigger";
  return s;
}

/**
 * 04-period-slide: 1xx slide-up, then 2xx slide-down.
 */
function buildPeriodSlide(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  for (let r = 1; r <= 4; r++) {
    pat.rows[r]![0] = cell({ effect: 0x01, effectParam: 0x04 });
  }
  for (let r = 5; r <= 8; r++) {
    pat.rows[r]![0] = cell({ effect: 0x02, effectParam: 0x08 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "period-slide";
  return s;
}

/**
 * 05-fine-slide: E1y / E2y (fine) and X1y / X2y (extra-fine).
 */
function buildFineSlide(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ effect: 0x0e, effectParam: 0x18 }); // E1y y=8
  pat.rows[4]![0] = cell({ effect: 0x0e, effectParam: 0x28 }); // E2y y=8
  pat.rows[6]![0] = cell({ effect: 0x21, effectParam: 0x18 }); // X1y y=8
  pat.rows[8]![0] = cell({ effect: 0x21, effectParam: 0x28 }); // X2y y=8
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "fine-slide";
  return s;
}

/**
 * 06-tone-porta: trigger C-4, porta to G-4 with 3xx.
 */
function buildTonePorta(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[4]![0] = cell({ note: 56, effect: 0x03, effectParam: 0x20 }); // G-4 + 320
  for (let r = 5; r <= 16; r++) {
    pat.rows[r]![0] = cell({ effect: 0x03, effectParam: 0x00 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "tone-porta";
  return s;
}

/**
 * 07-vibrato: 4xy speed=4 depth=8 held over rows.
 */
function buildVibrato(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x04,
    effectParam: 0x48,
  });
  for (let r = 1; r <= 16; r++) {
    pat.rows[r]![0] = cell({ effect: 0x04, effectParam: 0x00 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "vibrato";
  return s;
}

/**
 * 08-tremolo: 7xy speed=4 depth=8.
 */
function buildTremolo(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x07,
    effectParam: 0x48,
  });
  for (let r = 1; r <= 16; r++) {
    pat.rows[r]![0] = cell({ effect: 0x07, effectParam: 0x00 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "tremolo";
  return s;
}

/**
 * 09-tone-porta-vol-slide (5xy): porta + per-tick volume slide.
 */
function buildTonePortaVolSlide(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ note: 56, effect: 0x03, effectParam: 0x10 });
  for (let r = 3; r <= 10; r++) {
    pat.rows[r]![0] = cell({ effect: 0x05, effectParam: 0x04 }); // vol slide down 4
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "tone-porta-vol-slide";
  return s;
}

/**
 * 10-vibrato-vol-slide (6xy): vibrato + per-tick volume slide.
 */
function buildVibratoVolSlide(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x04,
    effectParam: 0x48,
  });
  for (let r = 1; r <= 12; r++) {
    pat.rows[r]![0] = cell({ effect: 0x06, effectParam: 0x40 }); // vol slide up 4
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "vibrato-vol-slide";
  return s;
}

/**
 * 11-set-finetune (E5y).
 */
function buildSetFinetune(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x0e,
    effectParam: 0x54,
  }); // E5y y=4
  pat.rows[8]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x0e,
    effectParam: 0x5c,
  }); // E5y y=12
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "set-finetune";
  return s;
}

/**
 * 12-set-volume (Cxx): direct volume changes.
 */
function buildSetVolume(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ effect: 0x0c, effectParam: 0x20 });
  pat.rows[4]![0] = cell({ effect: 0x0c, effectParam: 0x10 });
  pat.rows[6]![0] = cell({ effect: 0x0c, effectParam: 0x40 });
  pat.rows[8]![0] = cell({ effect: 0x0c, effectParam: 0x00 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "set-volume";
  return s;
}

/**
 * 13-fine-vol-slide (EAy / EBy): single-tick volume changes at tick 0.
 */
function buildFineVolSlide(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x0c,
    effectParam: 0x20,
  });
  for (let r = 1; r <= 6; r++) {
    pat.rows[r]![0] = cell({ effect: 0x0e, effectParam: 0xa4 }); // EAy
  }
  for (let r = 7; r <= 14; r++) {
    pat.rows[r]![0] = cell({ effect: 0x0e, effectParam: 0xb4 }); // EBy
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "fine-vol-slide";
  return s;
}

/**
 * 14-global-vol: Gxx (set) + Hxy (slide).
 */
function buildGlobalVolume(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ effect: 0x10, effectParam: 0x20 }); // G20
  pat.rows[4]![0] = cell({ effect: 0x10, effectParam: 0x40 }); // G40
  for (let r = 6; r <= 10; r++) {
    pat.rows[r]![0] = cell({ effect: 0x11, effectParam: 0x04 }); // H04 down
  }
  for (let r = 11; r <= 14; r++) {
    pat.rows[r]![0] = cell({ effect: 0x11, effectParam: 0x40 }); // H40 up
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "global-vol";
  return s;
}

/**
 * 15-panning: 8xx + E8y (coarse) + Pxy (slide).
 */
function buildPanning(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ effect: 0x08, effectParam: 0x00 }); // hard left
  pat.rows[4]![0] = cell({ effect: 0x08, effectParam: 0xff }); // hard right
  pat.rows[6]![0] = cell({ effect: 0x08, effectParam: 0x80 }); // center
  pat.rows[8]![0] = cell({ effect: 0x0e, effectParam: 0x80 }); // E8y y=0
  pat.rows[10]![0] = cell({ effect: 0x0e, effectParam: 0x8f }); // E8y y=15
  // Px0 = pan LEFT by x; P0y = pan RIGHT by y (ft2-clone / libxmp).
  for (let r = 12; r <= 16; r++) {
    pat.rows[r]![0] = cell({ effect: 0x19, effectParam: 0x40 }); // Pxy left 4
  }
  for (let r = 17; r <= 20; r++) {
    pat.rows[r]![0] = cell({ effect: 0x19, effectParam: 0x04 }); // Pxy right 4
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "panning";
  return s;
}

/**
 * 16-sample-offset (9xx). Re-trigger at different offsets.
 */
function buildSampleOffset(): XmSong {
  const samp = newSample(triangleSample(2048), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[4]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x09,
    effectParam: 0x04,
  });
  pat.rows[8]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x09,
    effectParam: 0x07,
  });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "sample-offset";
  return s;
}

/**
 * 17-note-cut (ECy).
 */
function buildNoteCut(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ effect: 0x0e, effectParam: 0xc2 }); // cut at tick 2
  pat.rows[4]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[6]![0] = cell({ effect: 0x0e, effectParam: 0xc0 }); // cut tick 0
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "note-cut";
  return s;
}

/**
 * 18-note-delay (EDy): defer trigger to tick y.
 */
function buildNoteDelay(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({
    note: 53,
    instrument: 1,
    effect: 0x0e,
    effectParam: 0xd3,
  });
  pat.rows[4]![0] = cell({
    note: 56,
    instrument: 1,
    effect: 0x0e,
    effectParam: 0xd5,
  });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "note-delay";
  return s;
}

/**
 * 19-set-speed (Fxx ≤ 32).
 */
function buildSetSpeed(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x0f,
    effectParam: 0x03,
  });
  pat.rows[8]![0] = cell({ effect: 0x0f, effectParam: 0x09 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "set-speed";
  return s;
}

/**
 * 20-set-tempo (Fxx > 32).
 */
function buildSetTempo(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x0f,
    effectParam: 0x80,
  });
  pat.rows[8]![0] = cell({ effect: 0x0f, effectParam: 0x50 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "set-tempo";
  return s;
}

/**
 * 21-multi-channel: 4 voices, different notes, hard-panned spread.
 */
function buildMultiChannel(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x08,
    effectParam: 0x00,
  });
  pat.rows[0]![1] = cell({
    note: 53,
    instrument: 1,
    effect: 0x08,
    effectParam: 0x40,
  });
  pat.rows[0]![2] = cell({
    note: 56,
    instrument: 1,
    effect: 0x08,
    effectParam: 0xc0,
  });
  pat.rows[0]![3] = cell({
    note: 61,
    instrument: 1,
    effect: 0x08,
    effectParam: 0xff,
  });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "multi-channel";
  return s;
}

/**
 * 22-key-off: note 97 + Kxx.
 */
function buildKeyOff(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ note: 97 });
  pat.rows[4]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[6]![0] = cell({ effect: 0x14, effectParam: 0x00 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "key-off";
  return s;
}

/**
 * 23-fadeout: key-off followed by fadeout decay.
 */
function buildFadeout(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst: XmInstrument = {
    ...newInstrument(samp, "tri"),
    fadeout: 0x1000,
  };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ note: 97 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "fadeout";
  return s;
}

/**
 * 24-volume-envelope: attack + sustain.
 */
function buildVolumeEnvelope(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst: XmInstrument = {
    ...newInstrument(samp, "tri"),
    volumeEnvelope: {
      enabled: true,
      sustainEnabled: true,
      loopEnabled: false,
      sustainPoint: 2,
      loopStart: 0,
      loopEnd: 0,
      points: [
        { tick: 0, value: 0 },
        { tick: 4, value: 64 },
        { tick: 20, value: 40 },
      ],
    },
  };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volume-envelope";
  return s;
}

/**
 * 25-pan-envelope: full-left to full-right sweep.
 */
function buildPanEnvelope(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst: XmInstrument = {
    ...newInstrument(samp, "tri"),
    panningEnvelope: {
      enabled: true,
      sustainEnabled: false,
      loopEnabled: false,
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      points: [
        { tick: 0, value: 0 },
        { tick: 30, value: 64 },
      ],
    },
  };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "pan-envelope";
  return s;
}

/**
 * 26-auto-vibrato: instrument-level vibrato with sweep.
 */
function buildAutoVibrato(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst: XmInstrument = {
    ...newInstrument(samp, "tri"),
    vibratoType: "sine",
    vibratoSweep: 40,
    vibratoDepth: 8,
    vibratoRate: 4,
  };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "auto-vibrato";
  return s;
}

/**
 * 27-set-env-pos (Lxx): jump volume envelope to a specific tick.
 */
function buildSetEnvPos(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst: XmInstrument = {
    ...newInstrument(samp, "tri"),
    volumeEnvelope: {
      enabled: true,
      sustainEnabled: false,
      loopEnabled: false,
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      points: [
        { tick: 0, value: 64 },
        { tick: 30, value: 0 },
      ],
    },
  };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({
    note: 49,
    instrument: 1,
    effect: 0x15,
    effectParam: 15,
  });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "set-env-pos";
  return s;
}

/**
 * 28-relative-note: sample with relativeNote=12 → C-4 trigger sounds C-5.
 */
function buildRelativeNote(): XmSong {
  const samp: XmSample = {
    ...newSample(triangleSample(512), "tri"),
    relativeNote: 12,
  };
  const inst = { ...newInstrument(samp, "tri"), samples: [samp] };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "relative-note";
  return s;
}

/**
 * 29-amiga-frequency: baseline played through Amiga period table.
 */
function buildAmigaFreq(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s = { ...s, flags: { linearFreq: false } };
  s.title = "amiga-freq";
  return s;
}

/**
 * 30-ping-pong-loop: sine-y waveform with ping-pong loop.
 */
function buildPingPongLoop(): XmSong {
  const data = new Int8Array(64);
  for (let i = 0; i < 64; i++) {
    data[i] = Math.round(100 * Math.sin((i / 64) * 2 * Math.PI));
  }
  const samp: XmSample = {
    name: "ping",
    data,
    bits: 8,
    loopStart: 0,
    loopLength: 64,
    loopType: "ping-pong",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
  const inst = { ...newInstrument(samp, "ping"), samples: [samp] };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "ping-pong-loop";
  return s;
}

/**
 * 31-sample-16bit: 16-bit sample data.
 */
function buildSample16(): XmSong {
  const data = new Int16Array(512);
  for (let i = 0; i < 512; i++) {
    const phase = i / 512;
    const v =
      phase < 0.5
        ? -25000 + phase * 4 * 25000
        : 25000 - (phase - 0.5) * 4 * 25000;
    data[i] = Math.round(v);
  }
  const samp: XmSample = {
    name: "tri16",
    data,
    bits: 16,
    loopStart: 0,
    loopLength: 512,
    loopType: "forward",
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
  const inst = { ...newInstrument(samp, "tri16"), samples: [samp] };
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "sample-16bit";
  return s;
}

/**
 * 32-pattern-break (Dxx): jump to next order at a specific row.
 */
function buildPatternBreak(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat0 = { rowCount: 16, rows: emptyRows(16, 4) };
  pat0.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat0.rows[4]![0] = cell({ effect: 0x0d, effectParam: 0x05 });
  const pat1 = { rowCount: 16, rows: emptyRows(16, 4) };
  pat1.rows[5]![0] = cell({ note: 56, instrument: 1 });
  let s = songWithPatterns([pat0, pat1], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "pattern-break";
  return s;
}

/**
 * 33-position-jump (Bxx): skip a pattern in the order list.
 */
function buildPositionJump(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat0 = { rowCount: 16, rows: emptyRows(16, 4) };
  pat0.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat0.rows[4]![0] = cell({ effect: 0x0b, effectParam: 0x02 });
  const pat1 = { rowCount: 16, rows: emptyRows(16, 4) };
  pat1.rows[0]![0] = cell({ note: 97 });
  const pat2 = { rowCount: 16, rows: emptyRows(16, 4) };
  pat2.rows[0]![0] = cell({ note: 56, instrument: 1 });
  let s = songWithPatterns([pat0, pat1, pat2], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "position-jump";
  return s;
}

/**
 * 34-volcol-set-vol (high nibble 1..5).
 */
function buildVolColSetVol(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1, volumeColumn: 0x50 });
  pat.rows[2]![0] = cell({ volumeColumn: 0x30 });
  pat.rows[4]![0] = cell({ volumeColumn: 0x20 });
  pat.rows[6]![0] = cell({ volumeColumn: 0x50 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-set-vol";
  return s;
}

/**
 * 35-volcol-vol-slide (high nibble 6 / 7).
 */
function buildVolColVolSlide(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  for (let r = 1; r <= 6; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0x64 });
  }
  for (let r = 7; r <= 14; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0x74 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-vol-slide";
  return s;
}

/**
 * 36-volcol-fine-vol (high nibble 8 / 9).
 */
function buildVolColFineVol(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1, volumeColumn: 0x40 });
  for (let r = 1; r <= 6; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0x84 });
  }
  for (let r = 7; r <= 12; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0x94 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-fine-vol";
  return s;
}

/**
 * 37-volcol-set-pan (high nibble C).
 */
function buildVolColSetPan(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ volumeColumn: 0xc0 });
  pat.rows[4]![0] = cell({ volumeColumn: 0xcf });
  pat.rows[6]![0] = cell({ volumeColumn: 0xc8 });
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-set-pan";
  return s;
}

/**
 * 38-volcol-pan-slide (high nibble D / E).
 */
function buildVolColPanSlide(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  for (let r = 1; r <= 8; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0xe4 });
  }
  for (let r = 9; r <= 16; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0xd4 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-pan-slide";
  return s;
}

/**
 * 39-volcol-tone-porta (high nibble F).
 */
function buildVolColTonePorta(): XmSong {
  const samp = newSample(squareSample(256), "sq");
  const inst = newInstrument(samp, "sq");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1 });
  pat.rows[2]![0] = cell({ note: 56, volumeColumn: 0xf4 });
  for (let r = 3; r <= 12; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0xf0 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-tone-porta";
  return s;
}

/**
 * 40-volcol-vibrato (high nibble A speed-set, B run-with-depth).
 */
function buildVolColVibrato(): XmSong {
  const samp = newSample(triangleSample(512), "tri");
  const inst = newInstrument(samp, "tri");
  const pat = { rowCount: 32, rows: emptyRows(32, 4) };
  pat.rows[0]![0] = cell({ note: 49, instrument: 1, volumeColumn: 0xa4 });
  for (let r = 1; r <= 12; r++) {
    pat.rows[r]![0] = cell({ volumeColumn: 0xb4 });
  }
  let s = songWithPatterns([pat], 4);
  s = setXmInstrument(s, 0, inst);
  s.title = "volcol-vibrato";
  return s;
}

// ─── Driver ────────────────────────────────────────────────────────────────

const FIXTURES: { name: string; build: () => XmSong }[] = [
  { name: "00-baseline", build: buildBaseline },
  { name: "01-volume-slide", build: buildVolSlide },
  { name: "02-arpeggio", build: buildArpeggio },
  { name: "03-retrigger", build: buildRetrigger },
  { name: "04-period-slide", build: buildPeriodSlide },
  { name: "05-fine-slide", build: buildFineSlide },
  { name: "06-tone-porta", build: buildTonePorta },
  { name: "07-vibrato", build: buildVibrato },
  { name: "08-tremolo", build: buildTremolo },
  { name: "09-tone-porta-vol-slide", build: buildTonePortaVolSlide },
  { name: "10-vibrato-vol-slide", build: buildVibratoVolSlide },
  { name: "11-set-finetune", build: buildSetFinetune },
  { name: "12-set-volume", build: buildSetVolume },
  { name: "13-fine-vol-slide", build: buildFineVolSlide },
  { name: "14-global-vol", build: buildGlobalVolume },
  { name: "15-panning", build: buildPanning },
  { name: "16-sample-offset", build: buildSampleOffset },
  { name: "17-note-cut", build: buildNoteCut },
  { name: "18-note-delay", build: buildNoteDelay },
  { name: "19-set-speed", build: buildSetSpeed },
  { name: "20-set-tempo", build: buildSetTempo },
  { name: "21-multi-channel", build: buildMultiChannel },
  { name: "22-key-off", build: buildKeyOff },
  { name: "23-fadeout", build: buildFadeout },
  { name: "24-volume-envelope", build: buildVolumeEnvelope },
  { name: "25-pan-envelope", build: buildPanEnvelope },
  { name: "26-auto-vibrato", build: buildAutoVibrato },
  { name: "27-set-env-pos", build: buildSetEnvPos },
  { name: "28-relative-note", build: buildRelativeNote },
  { name: "29-amiga-freq", build: buildAmigaFreq },
  { name: "30-ping-pong-loop", build: buildPingPongLoop },
  { name: "31-sample-16bit", build: buildSample16 },
  { name: "32-pattern-break", build: buildPatternBreak },
  { name: "33-position-jump", build: buildPositionJump },
  { name: "34-volcol-set-vol", build: buildVolColSetVol },
  { name: "35-volcol-vol-slide", build: buildVolColVolSlide },
  { name: "36-volcol-fine-vol", build: buildVolColFineVol },
  { name: "37-volcol-set-pan", build: buildVolColSetPan },
  { name: "38-volcol-pan-slide", build: buildVolColPanSlide },
  { name: "39-volcol-tone-porta", build: buildVolColTonePorta },
  { name: "40-volcol-vibrato", build: buildVolColVibrato },
];

const OUT_DIR = fileURLToPath(new URL("./", import.meta.url));

let count = 0;
for (const fx of FIXTURES) {
  const song = fx.build();
  const bytes = writeXm(song);
  const path = join(OUT_DIR, `${fx.name}.xm`);
  writeFileSync(path, bytes);
  console.log(`wrote ${fx.name}.xm (${bytes.length} bytes)`);
  count++;
}
console.log(`generated ${count} xm fixtures in ${OUT_DIR}`);

// Touch unused imports so the file stays self-documenting.
void emptyXmPattern;
