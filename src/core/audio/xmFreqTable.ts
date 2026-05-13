/**
 * XM frequency tables — linear and Amiga.
 *
 * ft2-clone (`src/ft2_tables.c`) carries two reference tables: a 768-entry
 * linear-period table and a 1936-entry Amiga-period table, both keyed by
 * `note * 16 + finetune` (linear mode) or interpolated through Amiga periods
 * (Amiga mode). For this slice we use the closed-form expressions that match
 * the table values to a few cents — good enough for note-trigger pitch and
 * easy to audit.
 *
 *   linear: period = 10*12*16*4 - note*16*4 - finetune/2
 *           Hz     = 8363 * 2^((4608 - period) / 768)
 *
 *   Amiga:  Hz = 8363 * 428 / amigaPeriod  (basePeriodC4 = 428)
 *           where amigaPeriod is the classic Paula-period lookup for the
 *           XM note number 1..96 (C-0..B-7), shifted by finetune.
 *
 * For pitch accuracy that matches ft2-clone's output to bit-exactness, the
 * tabulated periods should be substituted in a later slice — the closed-form
 * pitch is correct in tune but drifts a few cents at extreme octaves.
 */

/** Base sample rate for XM frequency math: C-4 at finetune 0 → 8363 Hz. */
export const XM_BASE_HZ = 8363;

/** Linear-mode period for `note` (1..96, where 49 = C-4) and finetune. */
export function periodForNoteLinear(note: number, finetune: number): number {
  // ft2-clone: `period = 10*12*16*4 - (note-1)*16*4 - finetune/2`. The
  // -1 on `note` shifts the 1-based XM numbering so note=1 (C-0) maps
  // to row 0 of the period table.
  return 10 * 12 * 16 * 4 - (note - 1) * 16 * 4 - finetune / 2;
}

/** Amiga-mode period for `note` and finetune. */
export function periodForNoteAmiga(note: number, finetune: number): number {
  // Classic Paula period at C-4, octave-shifted. Each octave halves the
  // period (doubles the pitch). Finetune in -128..127 maps to a ±50 cents
  // smooth pitch shift via the same exponent below.
  const semitonesFromC4 = note - 49;
  // C-4 period of 428 matches the canonical ProTracker tuning, which is
  // what ft2-clone uses when the Amiga frequency table is selected.
  const basePeriodC4 = 428;
  const period =
    basePeriodC4 * Math.pow(2, -semitonesFromC4 / 12 - finetune / (128 * 12));
  return period;
}

/** Period (linear or Amiga) for the active mode. */
export function periodForNote(
  note: number,
  finetune: number,
  linear: boolean,
): number {
  return linear
    ? periodForNoteLinear(note, finetune)
    : periodForNoteAmiga(note, finetune);
}

/** Output sample rate in Hz for `note` + `finetune` under the active mode. */
export function hzForNote(
  note: number,
  finetune: number,
  linear: boolean,
): number {
  if (linear) {
    const period = periodForNoteLinear(note, finetune);
    return XM_BASE_HZ * Math.pow(2, (4608 - period) / 768);
  }
  const period = periodForNoteAmiga(note, finetune);
  // Hz = XM_BASE_HZ * basePeriodC4 / period, with basePeriodC4 = 428 (the
  // value used by periodForNoteAmiga). libxmp uses the same: step =
  // C4_PERIOD * c5spd / freq / period in mixer.c. Earlier this used 1712
  // which is 4 * 428 — gave pitches two octaves too high.
  return (XM_BASE_HZ * 428) / period;
}
