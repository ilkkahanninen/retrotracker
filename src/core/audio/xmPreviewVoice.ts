/**
 * FT2 note audition as a live voice.
 *
 * A tiny one-channel song holds the note; an `XmReplayer` plays it for as
 * long as the key is held — the same model PT's preview uses (a real
 * voice that sounds until told to stop), so a looped sample sustains
 * indefinitely and envelopes / auto-vibrato / fadeout sound exactly as
 * they do in the song. Runs inside the preview worklet; kept free of
 * worklet globals so it can be unit-tested.
 *
 * It used to be a buffer pre-rendered on the main thread: four seconds
 * per key press, re-rendered in full on every slider tick, and silent
 * once the buffer ran out.
 */

import {
  XM_DEFAULT_TRACKER_NAME,
  XM_VERSION,
  emptyXmNote,
  emptyXmPattern,
} from "../xm/format";
import { XM_MAX_ORDERS, type XmInstrument, type XmSong } from "../xm/types";
import type { XmInterpolation } from "./types";
import { XmReplayer } from "./xmReplayer";

/** Rows in the idle pattern the preview song parks in. Any length works —
 *  the replayer just cycles it. */
const IDLE_ROWS = 64;

/**
 * Build the song that auditions `xmNote` on `instrument`.
 *
 * Two orders: a one-row pattern carrying the note, then an empty pattern
 * that the song restarts into forever (`restartPosition = 1`, played with
 * `loop: true`). The note is triggered once and never again, so it holds
 * for as long as the voice is left running.
 *
 * Only the auditioned instrument travels, as instrument 1: the song is
 * structured-cloned to the audio thread on every key press, and shipping
 * the whole instrument list would copy every sample in the module.
 *
 * `sampleIdx` forces every key onto that sample — the instrument editor
 * auditions the sample being edited, not whichever the key map assigns.
 */
export function buildXmPreviewSong(
  source: Pick<XmSong, "flags" | "defaultTempo" | "defaultBpm">,
  instrument: XmInstrument,
  xmNote: number,
  sampleIdx?: number,
): XmSong {
  const trigger = emptyXmPattern(1, 1);
  trigger.rows[0]![0] = { ...emptyXmNote(), note: xmNote, instrument: 1 };
  const orders = new Array<number>(XM_MAX_ORDERS).fill(0);
  orders[1] = 1;
  return {
    format: "FT2",
    title: "preview",
    trackerName: XM_DEFAULT_TRACKER_NAME,
    version: XM_VERSION,
    channelCount: 1,
    songLength: 2,
    restartPosition: 1,
    orders,
    patterns: [trigger, emptyXmPattern(IDLE_ROWS, 1)],
    instruments: [previewInstrument(instrument, sampleIdx)],
    flags: { linearFreq: source.flags.linearFreq },
    defaultTempo: source.defaultTempo,
    defaultBpm: source.defaultBpm,
  };
}

/** The instrument as the preview plays it: unchanged, or with its key
 *  map pointed at one sample. */
export function previewInstrument(
  instrument: XmInstrument,
  sampleIdx?: number,
): XmInstrument {
  if (sampleIdx === undefined) return instrument;
  return { ...instrument, keyMap: new Uint8Array(96).fill(sampleIdx) };
}

export interface XmPreviewVoiceOptions {
  interpolation: XmInterpolation;
  ramping: boolean;
}

export class XmPreviewVoice {
  private replayer: XmReplayer | null = null;

  constructor(private readonly sampleRate: number) {}

  /** True while a note is loaded (sounding or not yet run out). */
  get active(): boolean {
    return this.replayer !== null;
  }

  /** Start a fresh note; replaces whatever was sounding. */
  start(song: XmSong, opts: XmPreviewVoiceOptions): void {
    this.replayer = new XmReplayer(song, {
      sampleRate: this.sampleRate,
      loop: true,
      xmInterpolation: opts.interpolation,
      xmRamping: opts.ramping,
    });
  }

  /**
   * Swap the instrument under the sounding note — a sample-pipeline edit
   * made while the key is held. The voice keeps its position, so the
   * sound morphs instead of restarting. No-op when nothing is loaded.
   */
  swapInstrument(instrument: XmInstrument): void {
    this.replayer?.replaceInstrument(0, instrument);
  }

  stop(): void {
    this.replayer = null;
  }

  /**
   * Write `frames` of audio at `offset` (overwriting, silence when
   * nothing is loaded). Returns true when the note ran out during this
   * call — a non-looped sample reached its end, or the note never
   * triggered — after which the voice is unloaded.
   */
  process(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    offset = 0,
  ): boolean {
    left.fill(0, offset, offset + frames);
    if (right !== left) right.fill(0, offset, offset + frames);
    const r = this.replayer;
    if (!r) return false;
    r.process(left, right, frames, offset);
    if (!r.isSilent()) return false;
    this.replayer = null;
    return true;
  }
}
