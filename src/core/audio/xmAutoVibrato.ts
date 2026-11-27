/**
 * Instrument auto-vibrato, as FastTracker 2 plays it (ft2-clone
 * `updateVolPanAutoVib`). Kept apart from the replayer so the instrument
 * editor's preview draws exactly what the mixer will play.
 *
 * Each tick the phase (one byte, 256 = a full cycle) advances by the
 * instrument's rate, the waveform is sampled as a signed value in
 * -64..64, and `value * amplitude >> 14` period units are added to the
 * pitch. A positive value therefore lowers the pitch. Amplitude is the
 * depth in 8.8 fixed point, ramped in by the sweep.
 *
 * Notes on direction, because they are easy to get backwards:
 *   - sine starts by going *up* in pitch (the table opens negative);
 *   - square is high-pitched for the first half-cycle, low for the second;
 *   - type 2 in the file ("ramp-down") falls in pitch across a cycle,
 *     type 3 ("ramp-up") rises. ft2-clone labels them the other way round
 *     because it names the period ramp, not the pitch.
 * libxmp plays the sine inverted and uses a different numbering for types
 * 1..3, so it cannot serve as a reference for this effect.
 */

import type { XmAutoVibratoType } from "../xm/types";

/** FT2's auto-vibrato sine, one full cycle. Generated: ft2-clone's
 *  `autoVibSineTab` is exactly `-round(64 * sin(2π · i / 256))`. */
const AUTO_VIB_SINE = (() => {
  const table = new Int8Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = -Math.round(64 * Math.sin((i * 2 * Math.PI) / 256));
  }
  return table;
})();

/** Waveform value (-64..64) at `pos` (taken modulo 256). */
export function autoVibratoValue(pos: number, type: XmAutoVibratoType): number {
  const p = pos & 0xff;
  switch (type) {
    case "square":
      return p > 127 ? 64 : -64;
    case "ramp-down":
      // File type 2: 0 → 63, then -64 → -1.
      return (((p >> 1) + 64) & 127) - 64;
    case "ramp-up":
      // File type 3: 0 → -63, then 64 → 1.
      return ((-(p >> 1) + 64) & 127) - 64;
    default:
      return AUTO_VIB_SINE[p]!;
  }
}

/** Per-voice auto-vibrato state. */
export interface AutoVibratoState {
  /** LFO phase, 0..255. */
  pos: number;
  /** Current amplitude: depth in 8.8 fixed point. */
  amp: number;
  /** Amplitude added per tick while sweeping in; 0 once at full depth
   *  (or when the instrument has no sweep). */
  sweepStep: number;
}

export function newAutoVibratoState(): AutoVibratoState {
  return { pos: 0, amp: 0, sweepStep: 0 };
}

/** Restart the LFO for a freshly triggered note. */
export function resetAutoVibrato(
  state: AutoVibratoState,
  depth: number,
  sweep: number,
): void {
  // FT2 leaves the state untouched for instruments without auto-vibrato.
  if (depth <= 0) return;
  state.pos = 0;
  if (sweep > 0) {
    state.amp = 0;
    state.sweepStep = Math.floor((depth << 8) / sweep);
  } else {
    state.amp = depth << 8;
    state.sweepStep = 0;
  }
}

/**
 * Advance one tick and return the period offset to add to the pitch.
 *
 * Two FT2 quirks are reproduced: the sweep stops growing once the key is
 * released, and from then on only the per-tick step — not the amplitude
 * reached so far — is used; and a rate of 0 still applies the waveform's
 * value at phase 0, which for a square is a constant offset.
 */
export function stepAutoVibrato(
  state: AutoVibratoState,
  type: XmAutoVibratoType,
  depth: number,
  rate: number,
  keyOff: boolean,
): number {
  if (depth <= 0) return 0;
  let amp: number;
  if (state.sweepStep > 0) {
    amp = state.sweepStep;
    if (!keyOff) {
      amp += state.amp;
      if (amp >> 8 > depth) {
        amp = depth << 8;
        state.sweepStep = 0;
      }
      state.amp = amp;
    }
  } else {
    amp = state.amp;
  }
  state.pos = (state.pos + rate) & 0xff;
  return (autoVibratoValue(state.pos, type) * amp) >> 14;
}
