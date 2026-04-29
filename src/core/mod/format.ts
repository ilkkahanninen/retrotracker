import type { Note, Pattern, Sample, Song } from './types';
import { CHANNELS, MAX_ORDERS, NUM_SAMPLES, ROWS_PER_PATTERN } from './types';

/** Paula CPU clocks. Used to compute output sample rate from period.
 *  PAL: 28375160 / 4 (XTAL / 4); NTSC: 28636363 / 4. */
export const PAULA_CLOCK_PAL = 7093790.0;
export const PAULA_CLOCK_NTSC = 7159090.75;

/**
 * ProTracker period table.
 * Rows are finetune values 0..15 (0..7 = +0..+7, 8..15 = -8..-1, the way they
 * are stored in the .mod file). Columns are notes 0..35: C-1, C#1, ..., B-3.
 *
 * Sourced from pt2-clone replayer. A note's playback rate on Paula is
 * `clock / (period * 2)`.
 */
export const PERIOD_TABLE: readonly (readonly number[])[] = [
  // finetune 0
  [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
   428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
   214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113],
  // finetune 1
  [850, 802, 757, 715, 674, 637, 601, 567, 535, 505, 477, 450,
   425, 401, 379, 357, 337, 318, 300, 284, 268, 253, 239, 225,
   213, 201, 189, 179, 169, 159, 150, 142, 134, 126, 119, 113],
  // finetune 2
  [844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474, 447,
   422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237, 224,
   211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118, 112],
  // finetune 3
  [838, 791, 746, 704, 665, 628, 592, 559, 528, 498, 470, 444,
   419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235, 222,
   209, 198, 187, 176, 166, 158, 148, 140, 132, 125, 118, 111],
  // finetune 4
  [832, 785, 741, 699, 660, 623, 588, 555, 524, 495, 467, 441,
   416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233, 220,
   208, 196, 185, 175, 165, 156, 147, 139, 131, 124, 117, 110],
  // finetune 5
  [826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463, 437,
   413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232, 219,
   206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116, 109],
  // finetune 6
  [820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460, 434,
   410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230, 217,
   205, 193, 183, 172, 163, 154, 145, 137, 129, 122, 115, 109],
  // finetune 7
  [814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457, 431,
   407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228, 216,
   203, 192, 181, 171, 161, 152, 144, 136, 128, 121, 114, 108],
  // finetune -8 (stored as 8)
  [907, 856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480,
   453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240,
   226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120],
  // finetune -7 (9)
  [900, 850, 802, 757, 715, 675, 636, 601, 567, 535, 505, 477,
   450, 425, 401, 379, 357, 338, 318, 300, 284, 268, 253, 238,
   225, 212, 200, 189, 179, 169, 159, 150, 142, 134, 126, 119],
  // finetune -6 (10)
  [894, 844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474,
   447, 422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237,
   223, 211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118],
  // finetune -5 (11)
  [887, 838, 791, 746, 704, 665, 628, 593, 559, 528, 498, 470,
   444, 419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235,
   222, 209, 198, 187, 176, 166, 157, 148, 140, 132, 125, 118],
  // finetune -4 (12)
  [881, 832, 785, 741, 699, 660, 623, 588, 555, 524, 494, 467,
   441, 416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233,
   220, 208, 196, 185, 175, 165, 156, 147, 139, 131, 123, 117],
  // finetune -3 (13)
  [875, 826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463,
   437, 413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232,
   219, 206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116],
  // finetune -2 (14)
  [868, 820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460,
   434, 410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230,
   217, 205, 193, 183, 172, 163, 154, 145, 137, 129, 122, 115],
  // finetune -1 (15)
  [862, 814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457,
   431, 407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228,
   216, 203, 192, 181, 171, 161, 152, 144, 136, 128, 121, 114],
];

/**
 * MOD effect command codes (high nibble of effect byte).
 * The Exx extended commands further split on the high nibble of the parameter.
 */
export const Effect = {
  Arpeggio: 0x0,
  SlideUp: 0x1,
  SlideDown: 0x2,
  TonePortamento: 0x3,
  Vibrato: 0x4,
  TonePortamentoVolumeSlide: 0x5,
  VibratoVolumeSlide: 0x6,
  Tremolo: 0x7,
  /** PT2 uses 0x8 for "Set panning" only in some clones; classic PT ignores it. */
  Unused8: 0x8,
  SetSampleOffset: 0x9,
  VolumeSlide: 0xA,
  PositionJump: 0xB,
  SetVolume: 0xC,
  PatternBreak: 0xD,
  Extended: 0xE,
  SetSpeed: 0xF,
} as const;

export const ExtendedEffect = {
  SetFilter: 0x0,
  FineSlideUp: 0x1,
  FineSlideDown: 0x2,
  Glissando: 0x3,
  VibratoWaveform: 0x4,
  SetFinetune: 0x5,
  PatternLoop: 0x6,
  TremoloWaveform: 0x7,
  Unused8: 0x8,
  Retrigger: 0x9,
  FineVolumeSlideUp: 0xA,
  FineVolumeSlideDown: 0xB,
  NoteCut: 0xC,
  NoteDelay: 0xD,
  PatternDelay: 0xE,
  InvertLoop: 0xF,
} as const;

export function emptyNote(): Note {
  return { period: 0, sample: 0, effect: 0, effectParam: 0 };
}

export function emptyPattern(): Pattern {
  const rows: Note[][] = new Array(ROWS_PER_PATTERN);
  for (let r = 0; r < ROWS_PER_PATTERN; r++) {
    const row: Note[] = new Array(CHANNELS);
    for (let c = 0; c < CHANNELS; c++) row[c] = emptyNote();
    rows[r] = row;
  }
  return { rows };
}

export function emptySample(): Sample {
  return {
    name: '',
    lengthWords: 0,
    finetune: 0,
    volume: 0,
    loopStartWords: 0,
    loopLengthWords: 1,
    data: new Int8Array(0),
  };
}

export function emptySong(): Song {
  return {
    title: '',
    samples: Array.from({ length: NUM_SAMPLES }, emptySample),
    songLength: 1,
    restartPosition: 127,
    orders: new Array(MAX_ORDERS).fill(0),
    patterns: [emptyPattern()],
    signature: 'M.K.',
  };
}
