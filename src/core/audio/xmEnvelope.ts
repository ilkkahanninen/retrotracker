/**
 * Volume / panning envelope playback, as FastTracker 2 does it (ft2-clone
 * `updateVolPanAutoVib`, `setEnvelopePos`, `keyOff`).
 *
 * FT2 does not evaluate the envelope curve at a tick position. It walks the
 * points: when the tick counter reaches a point's x it loads that point's
 * value and an integer per-tick delta towards the next point, and on every
 * other tick it just adds the delta. Sustain and loop are decided at the
 * moment a point is reached. That design is where the format's well-known
 * edge cases come from, so it is ported as-is rather than approximated:
 *
 *   - deltas are truncated 8.8 fixed point, so a segment can land a little
 *     short of the next point before snapping to it;
 *   - sustain holds by *not* advancing to the next point while the tick
 *     counter keeps running; key-off rewinds the counter so the point is
 *     reached again and the envelope carries on;
 *   - a loop whose end is also the sustain point stops looping once the
 *     key is released;
 *   - a value that runs past 0..64 is clamped by inspecting only its high
 *     byte, as FT2 does.
 */

import type { XmEnvelope } from "../xm/types";

/** One envelope's playback state on a voice. */
export interface EnvelopeState {
  /** Tick counter, 16-bit. Starts at 65535 so the first step makes it 0. */
  tick: number;
  /** Index of the point the envelope is heading for. */
  pos: number;
  /** Current value, signed 8.8 fixed point (64 << 8 = full). */
  value: number;
  /** Signed 8.8 change per tick. */
  delta: number;
}

/** Full-scale envelope value: 64 in 8.8 fixed point. */
export const ENVELOPE_FULL = 64 << 8;

export function newEnvelopeState(): EnvelopeState {
  return { tick: 0xffff, pos: 0, value: 0, delta: 0 };
}

/** Restart for a freshly triggered instrument. FT2 leaves the value and
 *  delta alone; the first step loads them from point 0. */
export function resetEnvelope(state: EnvelopeState): void {
  state.tick = 0xffff;
  state.pos = 0;
}

const int8 = (n: number): number => (n << 24) >> 24;
const int16 = (n: number): number => (n << 16) >> 16;

/** 8.8 delta between two adjacent points (C integer division). */
function segmentDelta(y0: number, y1: number, xDiff: number): number {
  return Math.trunc((int8(y1 - y0) << 8) / xDiff);
}

/**
 * Advance one tick and return the envelope value in 8.8 fixed point
 * (normally 0..`ENVELOPE_FULL`).
 */
export function stepEnvelope(
  state: EnvelopeState,
  env: XmEnvelope,
  keyOff: boolean,
): number {
  const pts = env.points;
  const length = pts.length;
  let reachedPoint = false;
  let out = 0;
  let pos = state.pos;

  state.tick = (state.tick + 1) & 0xffff;
  const here = pts[pos];
  if (here !== undefined && state.tick === here.tick) {
    state.value = int8(here.value) << 8;
    pos++;
    if (env.loopEnabled) {
      pos--;
      if (pos === env.loopEnd) {
        // A loop ending on the sustain point is abandoned on key-off.
        const releases =
          env.sustainEnabled && pos === env.sustainPoint && keyOff;
        const start = pts[env.loopStart];
        if (!releases && start !== undefined) {
          pos = env.loopStart;
          state.tick = start.tick;
          state.value = int8(start.value) << 8;
        }
      }
      pos++;
    }

    if (pos < length) {
      let advance = true;
      if (env.sustainEnabled && !keyOff && pos - 1 === env.sustainPoint) {
        // Hold: stay on this point, stop moving.
        state.delta = 0;
        advance = false;
      }
      if (advance) {
        state.pos = pos;
        const a = pts[pos - 1]!;
        const b = pts[pos]!;
        const xDiff = b.tick - a.tick;
        if (xDiff > 0) {
          state.delta = segmentDelta(a.value, b.value, xDiff);
          out = state.value;
          reachedPoint = true;
        } else {
          state.delta = 0;
        }
      }
    } else {
      state.delta = 0;
    }
  }

  if (!reachedPoint) {
    state.value = int16(state.value + state.delta);
    out = state.value;
    // FT2 range-checks the high byte only, as an unsigned number.
    const hi = (out >> 8) & 0xff;
    if (hi > 64) {
      out = hi <= 160 ? ENVELOPE_FULL : 0;
      state.delta = 0;
    }
  }
  return out;
}

/**
 * Key-off: if the envelope has run past the point it is parked on (which
 * is how sustain holds), rewind the tick counter so the next step reaches
 * that point again and moves on.
 */
export function releaseEnvelope(state: EnvelopeState, env: XmEnvelope): void {
  const point = env.points[state.pos];
  if (point === undefined) return;
  if (state.tick >= point.tick) state.tick = (point.tick - 1) & 0xffff;
}

/**
 * Lxx: jump the envelope to tick `param`. Finds the segment containing the
 * tick and sets the value as if the envelope had been running. A tick that
 * lands exactly on a point leaves the value and delta untouched — FT2 only
 * tests for equality there.
 */
export function setEnvelopePosition(
  state: EnvelopeState,
  env: XmEnvelope,
  param: number,
): void {
  const pts = env.points;
  const length = pts.length;
  state.tick = (param - 1) & 0xffff;

  let point = 0;
  let snapToPoint = true;
  let tick = param;
  if (length > 1) {
    point++;
    for (let i = 0; i < length - 1; i++) {
      if (tick < pts[point]!.tick) {
        point--;
        tick -= pts[point]!.tick;
        if (tick === 0) {
          snapToPoint = false;
          break;
        }
        const a = pts[point]!;
        const b = pts[point + 1]!;
        const xDiff = b.tick - a.tick;
        if (xDiff <= 0) {
          snapToPoint = true;
          break;
        }
        state.delta = segmentDelta(a.value, b.value, xDiff);
        state.value = (int8(a.value) << 8) + int16(state.delta * (tick - 1));
        point++;
        snapToPoint = false;
        break;
      }
      point++;
    }
    if (snapToPoint) point--;
  }

  if (snapToPoint) {
    state.delta = 0;
    state.value = int8(pts[point]?.value ?? 0) << 8;
  }
  if (point >= length) point = Math.max(0, length - 1);
  state.pos = point;
}
