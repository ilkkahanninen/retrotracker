import { createSignal } from 'solid-js';
import type { Sample } from '../core/mod/types';
import { PAULA_CLOCK_PAL } from '../core/mod/format';

/**
 * Tracks the playhead of the currently-auditioned sample so the waveform
 * canvas can render a position cursor in real time. Decoupled from the
 * audio engine on purpose: we drive the visual from performance.now() and
 * the Paula rate, which lines up with audio playback to within ~16 ms of
 * RAF granularity (audio latency is on the same order). The alternative
 * — querying AudioContext.currentTime through the engine — would tie the
 * renderer to engine internals for what is, fundamentally, a UI cue.
 */

interface ActivePreview {
  /** 0-based sample slot the user is auditioning. */
  slot: number;
  /** performance.now() when the preview started. */
  startedAt: number;
  paulaRate: number;
  data: Int8Array;
  /** Loop start, in bytes (frames for 8-bit mono). */
  loopStart: number;
  /** Loop length, in bytes. */
  loopLen: number;
  /**
   * True iff the sample actually loops. PT's convention is that
   * `loopLengthWords > 1` means a real loop — empty / non-looped samples
   * carry `loopLengthWords === 1` (a sentinel, two bytes), which we must
   * NOT treat as a 2-byte loop or the playhead would wrap inside it
   * forever and look pinned at the start.
   */
  loops: boolean;
  /** Active requestAnimationFrame handle, so stopPreview can cancel it. */
  raf: number | null;
}

let active: ActivePreview | null = null;

const [position, setPosition] = createSignal<{ slot: number; frame: number } | null>(null);

/** Reactive accessor: `{ slot, frame }` while a preview is playing, else null. */
export const previewFrame = position;

/**
 * Begin tracking a preview. Cancels any prior preview first, then starts a
 * RAF loop that updates `previewFrame` every frame. For non-looped samples
 * the loop self-terminates when the playhead would walk off the end; for
 * looped samples the caller must invoke `stopPreview()` (typically on
 * keyup) — this mirrors how the audio engine treats looped previews.
 */
export function startPreview(slot: number, sample: Sample, period: number): void {
  stopPreview();
  if (period <= 0 || sample.data.byteLength === 0) return;
  const paulaRate = PAULA_CLOCK_PAL / (period * 2);
  active = {
    slot,
    startedAt: performance.now(),
    paulaRate,
    data: sample.data,
    loopStart: sample.loopStartWords * 2,
    loopLen: sample.loopLengthWords * 2,
    loops: sample.loopLengthWords > 1,
    raf: null,
  };
  const tick = () => {
    const a = active;
    if (!a) return;
    const elapsedSec = (performance.now() - a.startedAt) / 1000;
    const playedFrames = elapsedSec * a.paulaRate;
    const len = a.data.byteLength;
    if (a.loops) {
      let frame: number;
      if (playedFrames < a.loopStart + a.loopLen) {
        frame = Math.floor(playedFrames);
      } else {
        const beyond = playedFrames - a.loopStart;
        frame = a.loopStart + Math.floor(beyond % a.loopLen);
      }
      setPosition({ slot: a.slot, frame: Math.min(len - 1, Math.max(0, frame)) });
      a.raf = requestAnimationFrame(tick);
    } else if (playedFrames >= len) {
      stopPreview();
    } else {
      setPosition({ slot: a.slot, frame: Math.floor(playedFrames) });
      a.raf = requestAnimationFrame(tick);
    }
  };
  active.raf = requestAnimationFrame(tick);
}

/** Cancel any active preview and clear the playhead signal. Idempotent. */
export function stopPreview(): void {
  if (!active) return;
  if (active.raf !== null) cancelAnimationFrame(active.raf);
  active = null;
  setPosition(null);
}
