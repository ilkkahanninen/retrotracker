/**
 * FT2-mode note preview. The audio engine's preview path runs through
 * a single Paula voice (the worklet at [src/core/audio/preview-worklet.ts])
 * — that's PT2 territory. For a quick audition of an XM instrument we
 * adapt to it rather than carving out a parallel XM preview path: the
 * worklet only needs an `Int8Array` + Paula period to make a sound.
 *
 * Fidelity caveats (acceptable for auditions, not for playback):
 *   - 16-bit XM samples are down-shifted to 8-bit (>> 8).
 *   - XM finetune (-128..127) maps loosely onto PT's 4-bit (-8..7) by
 *     dividing by 16. The audition just needs to be close enough.
 *   - Notes outside PT's 3-octave window (C-1..B-3, slot 0..35) silently
 *     no-op — same as PT2's own `previewSampleAtPitch`.
 */

import { PERIOD_TABLE } from "../core/mod/format";
import type { Sample } from "../core/mod/types";
import type { XmSample } from "../core/xm/types";
import { triggerPreview } from "./playback";
import { transport, xm2Song as song } from "./song";
import { currentXmInstrument, currentXmOctave } from "./xmEdit";

/**
 * Map an XM note (1..96) + per-sample `relativeNote` and `finetune` to a
 * Paula period from PT2's finetune table. Returns 0 ("no period") when
 * the resulting note falls outside PT's 3-octave window.
 */
function xmNoteToPaulaPeriod(
  xmNote: number,
  relativeNote: number,
  xmFinetune: number,
): number {
  if (xmNote < 1 || xmNote > 96) return 0;
  const effective = xmNote + relativeNote;
  // XM note 13 == C-1 == PT slot 0. XM note 48 == B-3 == PT slot 35.
  const slot = effective - 13;
  if (slot < 0 || slot >= 36) return 0;
  // -128..127 → -8..7 (clamped). PT encodes -8..-1 as 8..15.
  const ft4 = Math.max(-8, Math.min(7, Math.round(xmFinetune / 16)));
  const ftRow = (ft4 + 16) % 16;
  return PERIOD_TABLE[ftRow]?.[slot] ?? 0;
}

/** Convert XM sample bytes to PT's 8-bit signed shape. */
function xmDataToInt8(xm: XmSample): Int8Array {
  if (xm.bits === 8) return xm.data as Int8Array;
  const src = xm.data as Int16Array;
  const dst = new Int8Array(src.length);
  for (let i = 0; i < src.length; i++) dst[i] = src[i]! >> 8;
  return dst;
}

/** Build a PT2-shaped Sample from an XmSample so the existing preview
 *  worklet can audition it. Word counts are derived from the 8-bit
 *  payload, mirroring how PT samples are sized in the worklet. */
function xmSampleAsPtSample(xm: XmSample): Sample {
  const data = xmDataToInt8(xm);
  const lengthBytes = data.length;
  const loopBytes = xm.loopType === "none" ? 0 : xm.loopLength;
  const loopStartWords = xm.loopStart >> 1;
  const loopLengthWords = loopBytes >> 1;
  return {
    name: xm.name,
    lengthWords: lengthBytes >> 1,
    finetune: 0,
    volume: xm.volume,
    loopStartWords,
    loopLengthWords,
    data,
  };
}

/**
 * Audition the current instrument's first sample at the piano-key
 * pitch. No commit, no cursor advance. Used by Shift+piano to hear a
 * note before deciding to type it for real, mirroring PT2's
 * `previewSampleAtPitch`. Multi-sample instruments preview through the
 * keymap entry for the pitched note, falling back to `samples[0]`.
 */
export function previewXmNote(semitoneOffset: number): void {
  if (transport() === "playing") return;
  const s = song();
  if (!s) return;
  // XM note: 1-based, octave 0 is notes 1..12. The PT-style currentOctave
  // is 1-based, so currentOctave 1 == XM octave 0 == base note 1.
  const xmNote = (currentXmOctave() - 1) * 12 + semitoneOffset + 1;
  if (xmNote < 1 || xmNote > 96) return;
  const inst = s.instruments[currentXmInstrument() - 1];
  if (!inst) return;
  if (inst.samples.length === 0) return;
  const mapIdx = inst.keyMap[xmNote - 1] ?? 0;
  const sample = inst.samples[mapIdx] ?? inst.samples[0];
  if (!sample || sample.data.length === 0) return;
  const period = xmNoteToPaulaPeriod(
    xmNote,
    sample.relativeNote,
    sample.finetune,
  );
  if (period === 0) return;
  triggerPreview(currentXmInstrument() - 1, xmSampleAsPtSample(sample), period);
}
