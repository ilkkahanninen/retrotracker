/**
 * FastTracker 2 replayer — Phase 5 Slices 1 + 2.
 *
 * Public surface mirrors `Pt2Replayer` so both can be hidden behind the
 * `Replayer` interface in `replayerCommon.ts`. The factory there picks the
 * right concrete class for the loaded song.
 *
 * Slice 1 coverage:
 *   - Pattern advance + Bxx / Cxx / Dxx / Fxx.
 *   - Note triggering with relativeNote + finetune mapped through linear
 *     or Amiga frequency tables (`xmFreqTable.ts`).
 *   - Per-voice linear-interpolation mixer with forward + ping-pong
 *     loop handling.
 *   - Volume column "set volume" (1..5 high-nibble).
 *
 * Slice 2 coverage (this file):
 *   - Effect column: 0xy arp, 1xx slide up, 2xx slide down, 3xx tone
 *     porta, 4xy vibrato, 5xy / 6xy combos, 7xy tremolo, 8xx set pan,
 *     9xx sample offset, Axy vol slide, Exy E-extended (E1y, E2y, E3y glissando, E4y,
 *     E5y, E6y pattern loop, E7y, E8y, E9y, EAy, EBy, ECy, EDy, EEy
 *     pattern delay), Gxx global vol, Hxy global vol slide, Kxx key
 *     off, Lxx set envelope position, Pxy pan slide, Rxy multi-retrigger,
 *     Txy tremor, Xxy X-extended (X1y / X2y extra-fine slides).
 *   - Volume column: 6 (slide down), 7 (slide up), 8 (fine slide down),
 *     9 (fine slide up), A (set vib speed), B (vibrato), C (set pan),
 *     D (pan slide left), E (pan slide right), F (tone porta speed).
 *
 * Slice 3 coverage: volume / panning envelopes (sustain + loop), fadeout,
 * autovibrato, multi-sample instruments via the keyMap, and note 97 / Kxx
 * releasing the envelope.
 *
 * Reference for behaviour: 8bitbubsy/ft2-clone (`src/ft2_replayer.c`).
 */

import type { Song } from "../song";
import type { Sample } from "../mod/types";
import type { XmInstrument, XmNote, XmSample, XmSong } from "../xm/types";
import type { ReplayerOptions, XmInterpolation } from "./types";
import { hzForNote, hzForPeriod, periodForNote } from "./xmFreqTable";
import {
  newAutoVibratoState,
  resetAutoVibrato,
  stepAutoVibrato,
  type AutoVibratoState,
} from "./xmAutoVibrato";

/**
 * Upper bound on E6x loop-backs within one order position before a
 * non-looping render gives up. A single E6F is 15 jumps; several of them in
 * a 256-row pattern stay far below this.
 */
const MAX_LOOP_JUMPS_PER_ORDER = 4096;

/** FT2's half-sine table for vibrato and tremolo (ft2-clone `vibratoTab`):
 *  32 unsigned steps covering one half-cycle, peak 255. */
// prettier-ignore
const XM_VIBRATO_TABLE = new Uint8Array([
    0,  24,  49,  74,  97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120,  97,  74,  49,  24,
]);

/**
 * Unsigned LFO magnitude (0..255) for vibrato / tremolo at `phase` (0..63;
 * the second half-cycle, 32..63, is where the caller flips the sign).
 * Waveform is the low two bits of E4y / E7y: 0 = sine, 1 = ramp, 2 and 3 =
 * square — FT2 has no random waveform. The ramp climbs 0..248 over a
 * half-cycle and is mirrored when `invertRamp` is set; the caller decides
 * which phase drives that, because FT2's tremolo reads the wrong one.
 */
function lfoMagnitude(
  phase: number,
  waveform: number,
  invertRamp: boolean,
): number {
  const index = phase & 0x1f;
  switch (waveform & 3) {
    case 0:
      return XM_VIBRATO_TABLE[index]!;
    case 1: {
      const ramp = index << 3;
      return invertRamp ? 255 - ramp : ramp;
    }
    default:
      return 255;
  }
}

interface XmVoice {
  /** True while a sample is actively playing on this channel. */
  playing: boolean;
  /** Currently-triggered sample reference, or null when silent. */
  sample: XmSample | null;
  /**
   * Sample-data read position as a double. libxmp keeps voice
   * position in `vi->pos` (double) for long-term accuracy and
   * derives a local 16.16 fixed-point pair (`pos_int`, `pos_frac`)
   * inside each mix function for the per-sample linear-interp math.
   * Using fixed-point for the long-term state introduces a sub-
   * sample drift over a long song (the quantised step accumulates a
   * tiny per-sample error); using a double for the long-term state
   * AND fixed-point locally for interp matches libxmp's bit-exact
   * output without that drift.
   */
  pos: number;
  /**
   * Sub-sample increment per output frame as a double. Also stored
   * in 16.16 fixed-point (`stepFixed`) for the mix loop's local
   * fixed-point progression — both are re-derived from `period` at
   * every tick. Direction (+1 forward / -1 reverse) sits on `direction`.
   */
  step: number;
  stepFixed: number;
  /** Ping-pong direction: +1 forward, -1 backward. */
  direction: 1 | -1;
  /**
   * True once the voice has wrapped (forward loop) or reflected
   * (ping-pong) at least once since it was triggered. The multi-tap
   * interpolators use it at the loop start: before the first wrap the
   * samples "behind" `loopStart` are the attack, afterwards they are the
   * loop's own tail.
   */
  looped: boolean;
  /**
   * Voice volume 0..64 (XM-native). Updated by Cxy, Axy, vol-col
   * 1..5/6/7/8/9, EAy/EBy. An accessor over `volumeRaw` (see `newVoice`):
   * every write also lifts a tremor mute, which is how FT2 behaves — any
   * volume update copies `realVol` back over the `outVol` tremor zeroed.
   */
  volume: number;
  /** Backing store for `volume`. Don't write it directly. */
  volumeRaw: number;
  /** Txy memory (x = ticks on − 1, y = ticks off − 1). */
  tremorParam: number;
  /** Txy phase, ft2-clone's `tremorPos`: bit 7 = "on" half, low bits =
   *  ticks left in the current half. Reset to 0 by a note trigger. */
  tremorPos: number;
  /**
   * True while tremor's "off" half is silencing the voice. Deliberately
   * outlives the Txy row: FT2 leaves the output volume at 0 until
   * something sets the volume again (see `volume`), so a tremor row that
   * ends mid-gap stays silent.
   */
  tremorMuted: boolean;
  /** Panning 0..255 (0 = left, 128 = center, 255 = right). */
  panning: number;
  /**
   * Volume tremolo last put on the output, or -1 for "no override". Like
   * FT2's `outVol` it is not recomputed on tick 0 and it outlives the 7xy
   * row: it holds until the next write to `volume`.
   */
  effectiveVolume: number;
  /** Note number that triggered the voice (1..96), 0 when silent. */
  note: number;
  /** Effective note after relativeNote applied. */
  effectiveNote: number;
  /** Instrument number 1..128 that produced the voice, 0 when silent. */
  instrument: number;
  /** Current pitch period (signed; smaller = higher pitch). */
  period: number;
  /** Finetune the voice was triggered with (or E5y's override), -128..127.
   *  Glissando needs it to land on this sample's semitones. */
  finetune: number;
  /** E3y: tone portamento moves in semitone steps while true. */
  glissando: boolean;
  /**
   * Semitone-rounded period that glissando puts on the output in place of
   * `period`, or 0 for none. The slide itself keeps running on `period`.
   * Like FT2's `outPeriod` it persists after the porta row, until another
   * effect writes the pitch (note trigger, slides, vibrato, arpeggio).
   */
  glissPeriod: number;
  /** Tone-porta target period. */
  portaTarget: number;
  /** Last seen porta speed (3xx memory; persists across rows). */
  portaSpeed: number;
  /** Vibrato speed (phase steps per tick), depth, and phase 0..63. */
  vibSpeed: number;
  vibDepth: number;
  vibPos: number;
  /** E4y value: bits 0-1 pick the waveform, bit 2 keeps `vibPos` running
   *  across note triggers instead of restarting it. */
  vibWaveform: number;
  /** Tremolo equivalents; `tremWaveform` is the E7y value. */
  tremSpeed: number;
  tremDepth: number;
  tremPos: number;
  tremWaveform: number;
  /** Effect number of the row before the current one — a row that follows
   *  vibrato without continuing it drops the vibrato offset (FT2). */
  lastEffect: number;
  /** Memory for 1xx / 2xx slides. */
  slideUpLast: number;
  slideDownLast: number;
  /** Memory for Axy vol slide. */
  volSlideLast: number;
  /** Memory for Pxy pan slide. */
  panSlideLast: number;
  /** Memory for 9xx sample offset. */
  sampleOffsetLast: number;
  /** Arpeggio param (last 0xy). */
  arpParam: number;
  /**
   * Arpeggio pitch offset in semitones, set by the per-tick handler
   * each tick and reset to 0 every advanceTick. Mirrors libxmp's
   * architecture: `xc->period` is the slide-modified period, and the
   * arpeggio offset is added at mixer time as a separate value rather
   * than mutating the persistent period. This way a non-arp row that
   * follows an arp row reverts to base pitch on tick 0 without
   * disrupting any in-flight slide.
   */
  arpOffset: number;
  /**
   * Per-tick vibrato period offset (4xy / 6xy / vol-col Bx). Reset to 0
   * every advanceTick and re-applied by `runVibrato` on per-tick effects.
   * Folded into the mixer period in `syncVoiceSteps`; the base period is
   * never modified. Like FT2's `outPeriod` it is not recomputed on tick 0
   * and holds its last value until another effect writes the pitch, or a
   * row follows 4xy / 6xy without continuing the vibrato.
   */
  vibOffset: number;
  /** Multi-retrigger Rxy memory. */
  retrigInterval: number;
  retrigVolChange: number;
  /** E60: row the next E6x on this channel loops back to. Persists across
   *  patterns (FT2 never resets it), so it defaults to row 0. */
  patLoopStartRow: number;
  /** E6x: loop passes still to go; 0 when no loop is in progress. */
  patLoopCounter: number;
  /** ECy: tick to cut at, or -1. */
  noteCutAt: number;
  /** EDy: tick to trigger at, or -1. Stored note/instrument fire on that tick. */
  noteDelayAt: number;
  noteDelayNote: number;
  noteDelayInst: number;
  /**
   * True after note 97 / Kxx — envelopes advance past the sustain point
   * and the fadeout-counter starts decrementing.
   */
  keyOff: boolean;
  /** Instrument auto-vibrato LFO; independent of the 4xy vibrato. */
  autoVib: AutoVibratoState;
  /** Period offset auto-vibrato produced for the current tick. */
  autoVibOffset: number;
  /**
   * Tick position into the volume envelope (X-coordinate of the point
   * array). Resets to 0 on instrument retrigger. Advances by 1 per tick
   * (subject to sustain hold + loop wrap).
   */
  volEnvPos: number;
  /** Same shape as volEnvPos, for the panning envelope. */
  panEnvPos: number;
  /**
   * 16-bit fadeout counter (ft2-clone uses 32768 as the "full" value).
   * Sits at 32768 while key is on; after keyOff each tick subtracts
   * `instrument.fadeout`, clamped to 0. Multiplies the final volume.
   */
  fadeoutVol: number;
  /** Cached instrument reference — envelopes/fadeout read off this each tick. */
  envInstrument: XmInstrument | null;
  /**
   * Anti-click voice-gain ramp state. libxmp ramps voice volume from the
   * previous tick's final gain to the new tick's gain over the first
   * `samplesPerTick >> ANTICLICK_SHIFT` samples of each tick (≈ 110
   * samples at BPM 125, 44.1 kHz). Without the ramp, a fresh note
   * trigger or a sudden volume change produces an audible click at the
   * sample boundary — and the head of every voice's WAV output
   * diverges from libxmp's by the full click amplitude.
   *
   * `currentLGain` / `currentRGain` are the gains the mixer is using
   * RIGHT NOW. `targetLGain` / `targetRGain` are the new tick's gains.
   * `rampDeltaL` / `rampDeltaR` are the per-sample increments. While
   * `rampLeft > 0`, the mixer advances current toward target each
   * sample; once it hits 0 we snap to target to avoid float drift.
   */
  currentLGain: number;
  currentRGain: number;
  targetLGain: number;
  targetRGain: number;
  rampDeltaL: number;
  rampDeltaR: number;
  rampLeft: number;
  /**
   * libxmp's "discharge" anti-click. When a voice retriggers (or
   * runs off the end of a non-looping sample), the previous voice's
   * last contributed sample stays in `sleft`/`sright`; on the next
   * mix chunk a quadratic decay of those values is added to the
   * output buffer over the first ~ticksize/8 samples. Combined with
   * the volume ramp from 0 → target, this fully removes click
   * artefacts on retrigger that the gain ramp alone leaves audible.
   *
   * `pendingDischarge` is set on retrigger and cleared on the next
   * mixChunk after the discharge runs. `sleft`/`sright` are the last
   * per-sample contribution this voice wrote (saved at the end of
   * mixVoice).
   */
  sleft: number;
  sright: number;
  pendingDischarge: boolean;
  /** Cached per-tick peak amplitude — drained by peakSnapshotAndReset. */
  peak: number;
}

function newVoice(): XmVoice {
  return {
    playing: false,
    sample: null,
    pos: 0,
    step: 0,
    stepFixed: 0,
    direction: 1,
    looped: false,
    volumeRaw: 0,
    get volume(): number {
      return this.volumeRaw;
    },
    set volume(value: number) {
      this.volumeRaw = value;
      this.tremorMuted = false;
      this.effectiveVolume = -1;
    },
    tremorParam: 0,
    tremorPos: 0,
    tremorMuted: false,
    panning: 128,
    effectiveVolume: -1,
    note: 0,
    effectiveNote: 0,
    instrument: 0,
    period: 0,
    finetune: 0,
    glissando: false,
    glissPeriod: 0,
    portaTarget: 0,
    portaSpeed: 0,
    lastEffect: 0,
    vibSpeed: 0,
    vibDepth: 0,
    vibPos: 0,
    vibWaveform: 0,
    tremSpeed: 0,
    tremDepth: 0,
    tremPos: 0,
    tremWaveform: 0,
    slideUpLast: 0,
    slideDownLast: 0,
    volSlideLast: 0,
    panSlideLast: 0,
    sampleOffsetLast: 0,
    arpParam: 0,
    arpOffset: 0,
    vibOffset: 0,
    retrigInterval: 0,
    retrigVolChange: 0,
    patLoopStartRow: 0,
    patLoopCounter: 0,
    noteCutAt: -1,
    noteDelayAt: -1,
    noteDelayNote: 0,
    noteDelayInst: 0,
    keyOff: false,
    autoVib: newAutoVibratoState(),
    autoVibOffset: 0,
    volEnvPos: 0,
    panEnvPos: 0,
    fadeoutVol: 32768,
    envInstrument: null,
    currentLGain: 0,
    currentRGain: 0,
    targetLGain: 0,
    targetRGain: 0,
    rampDeltaL: 0,
    rampDeltaR: 0,
    rampLeft: 0,
    sleft: 0,
    sright: 0,
    pendingDischarge: false,
    peak: 0,
  };
}

interface XmSongState {
  speed: number;
  tempo: number; // BPM
  tickInRow: number;
  row: number;
  orderIndex: number;
  /**
   * Total ticks (frames) elapsed since song start. Increments at the
   * top of every advanceTick. libxmp gates one-shot tick-0 behaviors
   * via `is_first_frame` (frame === 0); we mirror that with this
   * counter so vibrato phase doesn't advance on the song's first
   * frame, matching ft2-clone's "tick 0 of song start" quirk.
   */
  framesElapsed: number;
  /** Bxx queued target. -1 when no jump pending. */
  jumpToOrder: number;
  /** Dxx queued target. -1 when no jump pending. */
  jumpToRow: number;
  /** E6x queued loop-back row (same order). -1 when no loop jump pending. */
  loopJumpRow: number;
  /**
   * Row the next pattern starts on when the current one ends naturally.
   * Normally 0; an E6x loop jump leaves its start row here and nothing
   * clears it until the pattern changes — FT2's `pBreakPos` leftover,
   * the well-known "E60 bug" that modules written in FT2 rely on.
   */
  nextPatternStartRow: number;
  /** E6x jumps taken since the order last changed — runaway-loop guard. */
  loopJumpsInOrder: number;
  /** EEx: how many more times the current row repeats before advancing. */
  patternDelayRepeats: number;
  ended: boolean;
  /** (order << 16 | row) revisit set — drives song-end detection. */
  visited: Set<number>;
  /** Global volume 0..64 (Gxx / Hxy). */
  globalVolume: number;
  /** Memory for Hxy global vol slide. */
  globalVolSlideLast: number;
}

/**
 * Linear-interpolate an envelope value at tick position `pos`. Points
 * are sorted by tick; we walk to the bracketing pair and interpolate.
 * Out-of-range positions clamp to the first/last value.
 */
function envelopeValue(
  env: { points: { tick: number; value: number }[] },
  pos: number,
): number {
  const pts = env.points;
  if (pts.length === 0) return 64;
  if (pos <= pts[0]!.tick) return pts[0]!.value;
  if (pos >= pts[pts.length - 1]!.tick) return pts[pts.length - 1]!.value;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (pos >= a.tick && pos <= b.tick) {
      const span = b.tick - a.tick;
      if (span <= 0) return a.value;
      const t = (pos - a.tick) / span;
      return a.value + (b.value - a.value) * t;
    }
  }
  return pts[pts.length - 1]!.value;
}

/**
 * Advance one envelope position by 1 tick. Respects sustain (holds at
 * the sustain point's tick while key is on) and loop (wraps from
 * loopEnd's tick back to loopStart's tick). Returns the new position.
 */
function stepEnvelope(
  env: {
    points: { tick: number; value: number }[];
    sustainEnabled: boolean;
    sustainPoint: number;
    loopEnabled: boolean;
    loopStart: number;
    loopEnd: number;
  },
  pos: number,
  keyOff: boolean,
): number {
  const pts = env.points;
  if (pts.length === 0) return pos;
  let next = pos + 1;
  // Sustain hold: stop advancing once we reach the sustain point's tick,
  // until the user releases the key.
  if (env.sustainEnabled && !keyOff) {
    const sustain = pts[env.sustainPoint]?.tick;
    if (sustain !== undefined && pos >= sustain) return sustain;
  }
  // Loop wrap: when we step PAST loopEnd's tick, jump back to loopStart's.
  if (env.loopEnabled) {
    const loopEnd = pts[env.loopEnd]?.tick;
    const loopStart = pts[env.loopStart]?.tick;
    if (loopEnd !== undefined && loopStart !== undefined && next >= loopEnd) {
      next = loopStart;
    }
  }
  // Clamp at the final point so we don't run away into infinity.
  const lastTick = pts[pts.length - 1]!.tick;
  if (next > lastTick) next = lastTick;
  return next;
}

/** Clamp `period` to the playable range. */
function clampPeriod(p: number, linear: boolean): number {
  if (linear) {
    // Linear-mode period range: ~5..7424 (octave 0..7 mostly). Cap loosely.
    return Math.max(1, Math.min(7680, p));
  }
  // Amiga periods are in FT2's units (C-4 = 1712); FT2 itself clamps
  // slides to 1..31999.
  return Math.max(1, Math.min(31999, p));
}

/** Phases per sample step in the sinc kernel table. */
const SINC_PHASES = 256;
const SINC_TAPS = 8;

/**
 * 8-tap Blackman-windowed sinc kernel, `SINC_PHASES` fractional phases.
 * Row `p` holds the weights for taps at offsets -3..+4 around the integer
 * position when the fractional position is `p / SINC_PHASES`. Each row is
 * normalised to unity DC gain so the interpolator doesn't change level.
 * Built lazily — songs that stay on linear never pay for it.
 */
let sincTable: Float32Array | null = null;
function getSincTable(): Float32Array {
  if (sincTable) return sincTable;
  const t = new Float32Array(SINC_PHASES * SINC_TAPS);
  const half = SINC_TAPS / 2;
  for (let p = 0; p < SINC_PHASES; p++) {
    const frac = p / SINC_PHASES;
    let sum = 0;
    for (let k = 0; k < SINC_TAPS; k++) {
      // Tap k sits at offset (k - 3); distance from the read position:
      const x = k - (half - 1) - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman window over the kernel's [-half, half] support.
      const w = (x + half) / SINC_TAPS;
      const win =
        0.42 -
        0.5 * Math.cos(2 * Math.PI * w) +
        0.08 * Math.cos(4 * Math.PI * w);
      const v = sinc * win;
      t[p * SINC_TAPS + k] = v;
      sum += v;
    }
    for (let k = 0; k < SINC_TAPS; k++) t[p * SINC_TAPS + k]! /= sum;
  }
  sincTable = t;
  return t;
}

/**
 * Read the sample at `idx` for a multi-tap interpolator, resolving
 * indices that fall outside the playable region the same way the voice
 * itself would travel: forward loops wrap, ping-pong loops mirror, and a
 * one-shot holds its last value past the end (matching the linear path)
 * and reads silence before the start.
 *
 * `looped` says whether the voice has been round the loop yet. Until it
 * has, indices before `loopStart` are the attack it really played; after
 * that they resolve into the loop (its tail for a forward loop, the
 * mirror image for ping-pong) so the kernel doesn't pull attack samples
 * into every pass over the loop seam.
 */
function tapAt(
  data: Int8Array | Int16Array,
  idx: number,
  hasLoop: boolean,
  pingPong: boolean,
  loopStart: number,
  loopEnd: number,
  looped: boolean,
): number {
  if (hasLoop) {
    const len = loopEnd - loopStart;
    if (idx >= loopEnd) {
      idx = pingPong
        ? Math.max(loopStart, loopEnd - 1 - (idx - loopEnd))
        : loopStart + ((idx - loopStart) % len);
    } else if (looped && idx < loopStart) {
      idx = pingPong
        ? Math.min(loopEnd - 1, loopStart + (loopStart - idx - 1))
        : loopEnd - 1 - ((loopStart - idx - 1) % len);
    }
  } else if (idx >= data.length) {
    idx = data.length - 1;
  }
  return idx < 0 ? 0 : (data[idx] ?? 0);
}

export class XmReplayer {
  private song: XmSong;
  private readonly sampleRate: number;
  private readonly voices: XmVoice[];
  private readonly state: XmSongState;
  private readonly loop: boolean;
  /** Mutable so the worklet can flip Song↔Pattern playback mid-stream;
   *  picked up at the next pattern boundary. */
  private loopPattern: boolean;
  /** Per-channel live mute gate. */
  private readonly channelMuted: boolean[];
  /** Samples remaining until the next tick boundary. */
  private samplesUntilTick = 0;
  /** Total samples in the current tick — used for the anti-click ramp size. */
  private currentTickSamples = 0;
  /** Fractional accumulator so the tick rate matches ft2-clone exactly. */
  private tickFracAccum = 0;
  /** Cached "is linear-mode" flag for the active song's flags. */
  private linearFreq: boolean;
  /** Mixer resampling mode. `linear` is the reference / default path. */
  private interpolation: XmInterpolation;
  /** Anti-click gain ramp on tick boundaries. */
  private ramping: boolean;

  constructor(song: Song, opts: ReplayerOptions) {
    if (song.format !== "FT2") {
      throw new Error("XmReplayer: expected FT2 song");
    }
    this.song = song;
    this.sampleRate = opts.sampleRate;
    this.loop = opts.loop ?? false;
    this.loopPattern = opts.loopPattern ?? false;
    this.linearFreq = song.flags.linearFreq;
    this.interpolation = opts.xmInterpolation ?? "linear";
    this.ramping = opts.xmRamping ?? true;
    this.voices = new Array(song.channelCount);
    for (let i = 0; i < song.channelCount; i++) this.voices[i] = newVoice();
    this.channelMuted = new Array(song.channelCount).fill(false);
    if (opts.mutedChannels) {
      for (let i = 0; i < song.channelCount; i++) {
        this.channelMuted[i] = !!opts.mutedChannels[i];
      }
    }

    const startOrder = Math.max(
      0,
      Math.min(song.songLength - 1, opts.initialOrder ?? 0),
    );
    const startRow = Math.max(0, opts.initialRow ?? 0);

    this.state = {
      speed: opts.initialSpeed ?? song.defaultTempo,
      tempo: opts.initialTempo ?? song.defaultBpm,
      tickInRow: 0,
      row: startRow,
      orderIndex: startOrder,
      jumpToOrder: -1,
      jumpToRow: -1,
      loopJumpRow: -1,
      nextPatternStartRow: 0,
      loopJumpsInOrder: 0,
      patternDelayRepeats: 0,
      ended: false,
      visited: new Set(),
      globalVolume: 64,
      globalVolSlideLast: 0,
      framesElapsed: 0,
    };
    this.state.visited.add((startOrder << 16) | startRow);
    this.currentTickSamples = this.samplesPerTick();
    this.samplesUntilTick = this.currentTickSamples;
    this.processRow();
    // Seed anti-click ramp targets from the freshly-processed row so the
    // first chunk's mix ramps in from silence (currentGain = 0) over the
    // anti-click window. Without this the very first sample would be at
    // full target gain — the click libxmp ramps away.
    this.snapshotTickGains();
  }

  // ── Public surface (matches Replayer interface) ──────────────────────

  process(
    left: Float32Array,
    right: Float32Array,
    frames: number,
    offset = 0,
  ): void {
    if (left.length < offset + frames || right.length < offset + frames) {
      throw new Error("Output buffer too small");
    }
    let pos = offset;
    let remaining = frames;
    while (remaining > 0) {
      if (this.state.ended) {
        for (let i = 0; i < remaining; i++) {
          left[pos + i] = 0;
          right[pos + i] = 0;
        }
        return;
      }
      if (this.samplesUntilTick <= 0) {
        this.advanceTick();
        this.currentTickSamples = this.samplesPerTick();
        this.samplesUntilTick = this.currentTickSamples;
        if (this.state.ended) continue;
        // Snapshot the new tick's target gains AFTER period / envelope /
        // effects have all settled. The mixer ramps current → target
        // over the first `currentTickSamples >> ANTICLICK_SHIFT` samples
        // of this tick.
        this.snapshotTickGains();
      }
      const chunk = Math.min(remaining, this.samplesUntilTick);
      this.mixChunk(left, right, pos, chunk);
      pos += chunk;
      remaining -= chunk;
      this.samplesUntilTick -= chunk;
    }
  }

  isFinished(): boolean {
    return this.state.ended;
  }

  getOrderIndex(): number {
    return this.state.orderIndex;
  }

  getRow(): number {
    return this.state.row;
  }

  setChannelMuted(channel: number, muted: boolean): void {
    if (channel < 0 || channel >= this.voices.length) return;
    this.channelMuted[channel] = muted;
  }

  /** Swap the mixer interpolation mode; takes effect on the next chunk. */
  setXmInterpolation(mode: XmInterpolation): void {
    this.interpolation = mode;
  }

  /** Toggle the anti-click gain ramp; takes effect on the next tick. */
  setXmRamping(on: boolean): void {
    this.ramping = on;
  }

  /**
   * Flip the pattern-loop flag mid-playback. Picked up at the next pattern
   * boundary so the current pattern finishes either looping or advancing
   * depending on the fresh value.
   */
  setLoopPattern(on: boolean): void {
    this.loopPattern = on;
  }

  peakSnapshotAndReset(out: Float32Array): void {
    const n = Math.min(out.length, this.voices.length);
    for (let i = 0; i < n; i++) {
      out[i] = this.voices[i]!.peak;
      this.voices[i]!.peak = 0;
    }
    for (let i = n; i < out.length; i++) out[i] = 0;
  }

  replaceSong(song: Song): void {
    if (song.format !== "FT2") return;
    this.song = song;
    this.linearFreq = song.flags.linearFreq;
    if (this.state.orderIndex >= song.songLength) {
      this.state.orderIndex = Math.max(0, song.songLength - 1);
    }
    this.state.visited.clear();
    this.state.visited.add((this.state.orderIndex << 16) | this.state.row);
    if (this.voices.length !== song.channelCount) {
      this.voices.length = song.channelCount;
      for (let i = 0; i < song.channelCount; i++) {
        if (!this.voices[i]) this.voices[i] = newVoice();
      }
      this.channelMuted.length = song.channelCount;
      for (let i = 0; i < song.channelCount; i++) {
        if (this.channelMuted[i] === undefined) this.channelMuted[i] = false;
      }
    }
  }

  // PT-only methods — kept as no-ops so the interface check stays uniform.
  replaceSampleSlot(_slot: number, _sample: Sample): void {
    // FT2 uses instruments, not flat sample slots — the Phase 4 sample
    // editor will plumb XM-flavoured hot-swap.
  }

  // ── Tick scheduling ──────────────────────────────────────────────────

  private samplesPerTick(): number {
    const tickHz = (2 * this.state.tempo) / 5;
    const exact = this.sampleRate / tickHz;
    let n = Math.floor(exact);
    this.tickFracAccum += exact - n;
    if (this.tickFracAccum >= 1) {
      n++;
      this.tickFracAccum -= 1;
    }
    return Math.max(1, n);
  }

  private advanceTick(): void {
    this.state.tickInRow++;
    this.state.framesElapsed++;
    // The arpeggio offset is per tick: the handler sets it again on an
    // arp row, otherwise the mixer plays the unmodified period. Vibrato
    // and tremolo are not cleared here — FT2 holds their last output
    // through tick 0 (see `vibOffset` / `effectiveVolume`).
    for (const v of this.voices) v.arpOffset = 0;
    if (this.state.tickInRow >= this.state.speed) {
      this.state.tickInRow = 0;
      if (this.state.patternDelayRepeats > 0) {
        // EEx: hold the row. FT2 runs a repeat's first tick through the
        // per-tick effect path — notes and tick-0 effects do not re-fire.
        this.state.patternDelayRepeats--;
        this.runContinuousEffects();
      } else {
        this.advanceRow();
        if (this.state.ended) return;
        this.processRow();
      }
    } else {
      this.runContinuousEffects();
    }
    // Envelopes + fadeout advance every tick (including the row-trigger
    // tick) — they're independent of effect-column work. Run AFTER row
    // processing so the trigger row's envelope state is the freshly-reset
    // position 0 rather than a leftover from the prior row.
    this.advanceEnvelopes();
    // Recompute per-voice playback step (period may have changed).
    this.syncVoiceSteps();
  }

  // ── Envelopes + fadeout ──────────────────────────────────────────────

  private applyKeyOff(v: XmVoice): void {
    v.keyOff = true;
    // ft2-clone: if the volume envelope isn't enabled, the voice's
    // amplitude must be driven to silence purely by fadeout — so we
    // need a guarantee that fadeoutVol drops. The fadeout value lives
    // on the instrument; if it's zero, ft2-clone snaps the voice to
    // silence at the next tick (otherwise it would ring forever).
    const inst = v.envInstrument;
    const hasVolEnv = !!inst?.volumeEnvelope?.enabled;
    if (!hasVolEnv && (inst?.fadeout ?? 0) === 0) {
      v.volume = 0;
    }
  }

  private advanceEnvelopes(): void {
    for (const v of this.voices) {
      if (!v.playing || !v.envInstrument) continue;
      const inst = v.envInstrument;
      // Fadeout: only ticks down once the key has released.
      if (v.keyOff && inst.fadeout > 0) {
        v.fadeoutVol = Math.max(0, v.fadeoutVol - inst.fadeout);
        if (v.fadeoutVol === 0) {
          // Sample silenced — don't bother mixing, but keep the voice
          // marked playing so a follow-up trigger picks up cleanly.
          v.volume = 0;
        }
      }
      // Volume envelope.
      if (inst.volumeEnvelope.enabled) {
        v.volEnvPos = stepEnvelope(inst.volumeEnvelope, v.volEnvPos, v.keyOff);
      }
      // Panning envelope.
      if (inst.panningEnvelope.enabled) {
        v.panEnvPos = stepEnvelope(inst.panningEnvelope, v.panEnvPos, v.keyOff);
      }
      // Auto-vibrato: one LFO step per tick; `syncVoiceSteps` folds the
      // resulting offset into the pitch.
      v.autoVibOffset = stepAutoVibrato(
        v.autoVib,
        inst.vibratoType,
        inst.vibratoDepth,
        inst.vibratoRate,
        v.keyOff,
      );
    }
  }

  // ── Anti-click voice-gain ramp ───────────────────────────────────────
  //
  // libxmp linearly ramps voice volume from the previous tick's final
  // gain to the new tick's gain over the first ~ticksize>>3 samples
  // (~110 at BPM 125, 44.1 kHz). Without the ramp, a fresh trigger
  // produces a sample-edge click at the head of the buffer that
  // dominates any per-sample diff. The ramp is per-voice + per-channel
  // (L/R) because pan changes also cause discontinuities.

  /** ft2-clone / libxmp anti-click ramp size as a power-of-2 shift of
   *  the tick length. 3 → ticksize/8 ≈ 110 samples at default tempo. */
  private static readonly ANTICLICK_SHIFT = 3;

  /**
   * Compute a voice's target (L, R) gain for the current tick using
   * the same pipeline the mixer used to inline: voiceVol (tremolo
   * override) → / 64 → globalGain → volume-envelope factor → fadeout
   * factor → pan (with panning-envelope offset). Returns [0, 0] for
   * silent / muted voices.
   */
  private computeVoiceGain(v: XmVoice, channelIdx: number): [number, number] {
    if (!v.playing || !v.sample) return [0, 0];
    if (this.channelMuted[channelIdx]) return [0, 0];
    const voiceVol =
      v.effectiveVolume >= 0 ? v.effectiveVolume : v.tremorMuted ? 0 : v.volume;
    const volEnvFactor = this.volEnvelopeFactor(v);
    const fadeFactor = v.fadeoutVol / 32768;
    const panOffset = this.panEnvelopeOffset(v);
    const pan = Math.max(0, Math.min(255, v.panning + panOffset * 4));
    // libxmp's mixer (mixer.c MIX_OUT) splits the 0..255 byte over a
    // /256 denominator: L = (256 - pan) / 256, R = pan / 256. /255
    // produces an asymmetric centre and a 0.4% L/R imbalance which
    // shows up as ~0.05 RMS divergence on hard-panned fixtures.
    const panNorm = pan / 256;
    const globalGain = this.state.globalVolume / 64;
    const linVol = (voiceVol / 64) * globalGain * volEnvFactor * fadeFactor;
    return [(1 - panNorm) * linVol, panNorm * linVol];
  }

  /**
   * Called once per tick (after row / per-tick effects / envelopes /
   * autovibrato all run). For each voice, computes the new target
   * gains and seeds the ramp from the voice's current gain (which is
   * either the previous tick's target, or partway through ramping
   * toward it if the previous tick was very short — the mixer always
   * snaps to target at ramp end so the latter is rare).
   */
  private snapshotTickGains(): void {
    const rampSize = Math.max(
      1,
      this.currentTickSamples >> XmReplayer.ANTICLICK_SHIFT,
    );
    for (let c = 0; c < this.voices.length; c++) {
      const v = this.voices[c]!;
      const [tL, tR] = this.computeVoiceGain(v, c);
      v.targetLGain = tL;
      v.targetRGain = tR;
      // No-change → no ramp; saves work in mixVoice's hot loop. With
      // ramping switched off, step straight to the new gain.
      if (!this.ramping) {
        v.currentLGain = tL;
        v.currentRGain = tR;
        v.rampLeft = 0;
        v.rampDeltaL = 0;
        v.rampDeltaR = 0;
      } else if (v.currentLGain === tL && v.currentRGain === tR) {
        v.rampLeft = 0;
        v.rampDeltaL = 0;
        v.rampDeltaR = 0;
      } else {
        v.rampDeltaL = (tL - v.currentLGain) / rampSize;
        v.rampDeltaR = (tR - v.currentRGain) / rampSize;
        v.rampLeft = rampSize;
      }
    }
  }

  /** Sample the volume envelope (0..1, where 1 == 64/64 unit gain). */
  private volEnvelopeFactor(v: XmVoice): number {
    const inst = v.envInstrument;
    if (!inst || !inst.volumeEnvelope.enabled) return 1;
    return envelopeValue(inst.volumeEnvelope, v.volEnvPos) / 64;
  }

  /** Sample the panning envelope as a signed offset (-32..+32). */
  private panEnvelopeOffset(v: XmVoice): number {
    const inst = v.envInstrument;
    if (!inst || !inst.panningEnvelope.enabled) return 0;
    // XM panning envelope is 0..64 centred at 32 — convert to ±32 offset.
    return envelopeValue(inst.panningEnvelope, v.panEnvPos) - 32;
  }

  /** Re-derive each voice's `step` from its current `period`. */
  private syncVoiceSteps(): void {
    for (const v of this.voices) {
      if (!v.playing || !v.sample) continue;
      if (v.period <= 0) continue;
      // Auto-vibrato overlays a per-tick pitch offset; the base period
      // (`v.period`) is unchanged, so slides keep working.
      const autoVibOffset = v.autoVibOffset;
      // Arpeggio offset (semitones). Linear periods are 64 units per
      // semitone, so it is a plain subtraction; Amiga periods are
      // inversely proportional to frequency, so the base period is
      // scaled by the semitone ratio instead.
      const base = v.glissPeriod || v.period;
      const arpBase = this.linearFreq
        ? base - v.arpOffset * 64
        : v.arpOffset === 0
          ? base
          : base * Math.pow(2, -v.arpOffset / 12);
      const effectivePeriod = clampPeriod(
        arpBase + autoVibOffset + v.vibOffset,
        this.linearFreq,
      );
      const hz = hzForPeriod(effectivePeriod, this.linearFreq);

      // Store both the double step (used to advance the voice's
      // double `pos` per sample) and its 16.16 fixed-point form
      // (used as the local `posFrac` increment for libxmp's interp).
      // libxmp passes its `step * (1 << SMIX_SHIFT)` to mix_fn
      // through an `int` parameter — a C cast that truncates toward
      // zero. Our step is always ≥ 0 so trunc == floor — use `|0` to
      // match libxmp exactly.
      v.step = hz / this.sampleRate;
      v.stepFixed = (v.step * 65536) | 0;
    }
  }

  // ── Row / pattern advance ────────────────────────────────────────────

  private advanceRow(): void {
    let nextOrder = this.state.orderIndex;
    let nextRow = this.state.row + 1;
    if (this.state.jumpToOrder !== -1) {
      nextOrder = this.state.jumpToOrder;
      nextRow = this.state.jumpToRow !== -1 ? this.state.jumpToRow : 0;
      this.state.jumpToOrder = -1;
      this.state.jumpToRow = -1;
      // Bxx / Dxx name their target row outright and win over an E6x on
      // the same row.
      this.state.loopJumpRow = -1;
      this.state.nextPatternStartRow = 0;
    } else if (this.state.jumpToRow !== -1) {
      nextOrder = this.state.orderIndex + 1;
      nextRow = this.state.jumpToRow;
      this.state.jumpToRow = -1;
      this.state.loopJumpRow = -1;
      this.state.nextPatternStartRow = 0;
    } else if (this.state.loopJumpRow !== -1) {
      // E6x loop-back inside the current order.
      nextRow = this.state.loopJumpRow;
      this.state.loopJumpRow = -1;
      this.state.nextPatternStartRow = nextRow;
      // The loop body is about to be replayed on purpose, so it must not
      // trip the revisit-based song-end check below. A counter stands in
      // for it: loops that feed each other across channels can spin
      // forever in FT2, and an offline render has to terminate.
      for (let r = nextRow; r <= this.state.row; r++) {
        this.state.visited.delete((nextOrder << 16) | r);
      }
      this.state.loopJumpsInOrder++;
      if (
        this.state.loopJumpsInOrder > MAX_LOOP_JUMPS_PER_ORDER &&
        !this.loop &&
        !this.loopPattern
      ) {
        this.state.ended = true;
        return;
      }
    } else {
      const patIdx = this.song.orders[this.state.orderIndex] ?? 0;
      const pat = this.song.patterns[patIdx];
      const rowCount = pat?.rowCount ?? 64;
      if (nextRow >= rowCount) {
        if (this.loopPattern) {
          nextRow = 0;
        } else {
          nextOrder = this.state.orderIndex + 1;
          nextRow = this.nextPatternStartRowFor(nextOrder);
        }
        this.state.nextPatternStartRow = 0;
      }
    }
    if (nextOrder >= this.song.songLength) {
      if (this.loop) {
        nextOrder = this.song.restartPosition;
        if (nextOrder >= this.song.songLength) nextOrder = 0;
        this.state.visited.clear();
      } else {
        this.state.ended = true;
        return;
      }
    }
    if (this.loopPattern) nextOrder = this.state.orderIndex;
    const key = (nextOrder << 16) | nextRow;
    if (!this.loop && !this.loopPattern && this.state.visited.has(key)) {
      this.state.ended = true;
      return;
    }
    this.state.visited.add(key);
    if (nextOrder !== this.state.orderIndex) this.state.loopJumpsInOrder = 0;
    this.state.orderIndex = nextOrder;
    this.state.row = nextRow;
  }

  /**
   * Start row for `order` when the previous pattern ran off its end: the
   * E6x leftover (see `nextPatternStartRow`), or 0 when that row does not
   * exist in the pattern being entered.
   */
  private nextPatternStartRowFor(order: number): number {
    const row = this.state.nextPatternStartRow;
    if (row === 0) return 0;
    const pat = this.song.patterns[this.song.orders[order] ?? 0];
    return row < (pat?.rowCount ?? 64) ? row : 0;
  }

  private processRow(): void {
    const patIdx = this.song.orders[this.state.orderIndex] ?? 0;
    const pat = this.song.patterns[patIdx];
    if (!pat) return;
    const row = pat.rows[this.state.row];
    if (!row) return;
    for (let c = 0; c < this.voices.length && c < row.length; c++) {
      this.processCell(c, row[c]!);
    }
  }

  // ── Row trigger (tick 0) ────────────────────────────────────────────

  private processCell(channel: number, cell: XmNote): void {
    const v = this.voices[channel]!;
    const hadVibrato = v.lastEffect === 0x04 || v.lastEffect === 0x06;
    const hasVibrato = cell.effect === 0x04 || cell.effect === 0x06;
    if (hadVibrato && !hasVibrato) v.vibOffset = 0;
    v.lastEffect = cell.effect;
    // Reset one-shot deferred-trigger state from the previous row.
    v.noteCutAt = -1;
    v.noteDelayAt = -1;
    v.noteDelayNote = 0;
    v.noteDelayInst = 0;
    // Cache whether this row carries an EDy "note delay" — the note +
    // instrument fire on tick `y` instead of tick 0.
    const isNoteDelay =
      cell.effect === 0x0e && (cell.effectParam & 0xf0) === 0xd0;
    const delayTick = isNoteDelay ? cell.effectParam & 0x0f : -1;
    // Tone porta: note doesn't retrigger, just sets the porta target.
    const isTonePorta =
      cell.effect === 0x03 ||
      cell.effect === 0x05 ||
      (cell.volumeColumn & 0xf0) === 0xf0;
    if (isNoteDelay && delayTick > 0) {
      // Stash the trigger for the tick handler.
      v.noteDelayAt = delayTick;
      v.noteDelayNote = cell.note;
      v.noteDelayInst = cell.instrument;
    } else {
      this.applyNoteInstrument(channel, cell, isTonePorta);
    }
    // Volume column (tick-0 half).
    this.applyVolumeColumnTick0(channel, cell.volumeColumn);
    // Effect column (tick-0 half).
    this.applyEffectColumnTick0(channel, cell);
  }

  /**
   * Apply the note + instrument trigger semantics. Tone-porta rows
   * (3xx, 5xy, or vol-column F) don't restart the sample — they set
   * the porta target instead.
   */
  private applyNoteInstrument(
    channel: number,
    cell: XmNote,
    isTonePorta: boolean,
  ): void {
    const v = this.voices[channel]!;
    if (cell.note > 0 && cell.note <= 96) {
      if (isTonePorta) {
        // Stash the target period; the porta tick handler walks toward it.
        const inst = this.instrumentFor(cell.instrument || v.instrument);
        const samp = inst ? this.sampleForNote(inst, cell.note) : undefined;
        if (samp) {
          const effectiveNote = cell.note + samp.relativeNote;
          if (effectiveNote >= 1 && effectiveNote <= 96) {
            v.portaTarget = periodForNote(
              effectiveNote,
              samp.finetune,
              this.linearFreq,
            );
          }
        }
      } else {
        this.triggerNote(channel, cell.note, cell.instrument);
      }
    } else if (cell.note === 97) {
      // Key off — envelopes advance past sustain and fadeout starts
      // decrementing. The voice stays playing until either an envelope
      // hits zero, fadeout reaches zero, or the sample ends.
      this.applyKeyOff(v);
    } else if (cell.instrument > 0) {
      // Instrument-only row — XM "reset volume / pan to sample default".
      // Use the voice's last-played note for the keyMap lookup so a
      // drum-kit instrument resolves to the right sample's defaults.
      const inst = this.instrumentFor(cell.instrument);
      const samp = inst ? this.sampleForNote(inst, v.note || 49) : undefined;
      if (samp) {
        v.volume = samp.volume;
        v.panning = samp.panning;
      }
    }
  }

  private instrumentFor(instrumentNumber: number): XmInstrument | undefined {
    return instrumentNumber
      ? this.song.instruments[instrumentNumber - 1]
      : undefined;
  }

  /**
   * Resolve the active sample for `note` on `instrument`. Reads the
   * 96-byte keyMap (drum kits route each key to a different sample
   * within the instrument). Falls back to `samples[0]` when the keyMap
   * value points past the end of the array.
   */
  private sampleForNote(
    inst: XmInstrument,
    note: number,
  ): XmSample | undefined {
    if (note < 1 || note > 96) return undefined;
    const idx = inst.keyMap[note - 1] ?? 0;
    return inst.samples[idx] ?? inst.samples[0];
  }

  private triggerNote(
    channel: number,
    note: number,
    instrumentNumber: number,
  ): void {
    const v = this.voices[channel]!;
    const inst = this.instrumentFor(instrumentNumber || v.instrument);
    if (!inst) {
      v.playing = false;
      return;
    }
    const samp = this.sampleForNote(inst, note);
    if (!samp || samp.data.length === 0) {
      v.playing = false;
      return;
    }
    // Re-trigger over a still-playing voice → queue an anti-click
    // discharge of the previous voice's last sample over the next
    // ramp window, AND reset the voice's current gain to 0 so the
    // new voice ramps in from 0 while the discharge decays out.
    // libxmp's `anticlick` does the same: it sets vi->old_vl = 0 +
    // adds the ANTICLICK flag, so the next snapshotTickGains seeds
    // the ramp from 0 to the new target.
    if (v.playing) {
      v.pendingDischarge = true;
      v.currentLGain = 0;
      v.currentRGain = 0;
    }
    const effectiveNote = note + samp.relativeNote;
    if (effectiveNote < 1 || effectiveNote > 96) {
      v.playing = false;
      return;
    }
    v.sample = samp;
    v.pos = 0;
    v.direction = 1;
    v.looped = false;
    v.playing = true;
    v.note = note;
    v.effectiveNote = effectiveNote;
    v.instrument = instrumentNumber || v.instrument;
    if (instrumentNumber > 0) {
      v.volume = samp.volume;
      v.panning = samp.panning;
    }
    v.period = periodForNote(effectiveNote, samp.finetune, this.linearFreq);
    v.finetune = samp.finetune;
    v.glissPeriod = 0;
    v.vibOffset = 0;
    v.tremorPos = 0;
    v.portaTarget = v.period;
    // A note trigger restarts the vibrato / tremolo phase unless bit 2 of
    // the E4y / E7y value asks to keep it running (values 4..7).
    if ((v.vibWaveform & 4) === 0) v.vibPos = 0;
    if ((v.tremWaveform & 4) === 0) v.tremPos = 0;
    v.step = hzForPeriod(v.period, this.linearFreq) / this.sampleRate;
    v.stepFixed = (v.step * 65536) | 0;
    // Envelope reset on retrigger: volume + panning envelopes go back to
    // tick 0, key-off flag clears, fadeout counter goes back to full.
    // Cache the instrument reference so the per-tick env advance doesn't
    // have to re-resolve it.
    v.envInstrument = inst;
    v.volEnvPos = 0;
    v.panEnvPos = 0;
    v.keyOff = false;
    v.fadeoutVol = 32768;
    // Auto-vibrato restarts (phase and sweep) on every retrigger.
    v.autoVibOffset = 0;
    if (inst) {
      resetAutoVibrato(v.autoVib, inst.vibratoDepth, inst.vibratoSweep);
    }
  }

  // ── Volume column ────────────────────────────────────────────────────

  private applyVolumeColumnTick0(channel: number, byte: number): void {
    if (byte === 0) return;
    const v = this.voices[channel]!;
    const hi = (byte >>> 4) & 0xf;
    const lo = byte & 0xf;
    switch (hi) {
      case 0:
        break;
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
        v.volume = byte - 0x10;
        break;
      case 0x8: // Fine vol slide down
        v.volume = Math.max(0, v.volume - lo);
        break;
      case 0x9: // Fine vol slide up
        v.volume = Math.min(64, v.volume + lo);
        break;
      case 0xa: // Set vibrato speed
        if (lo !== 0) v.vibSpeed = lo;
        break;
      case 0xb: // Vibrato w/ depth
        if (lo !== 0) v.vibDepth = lo;
        break;
      case 0xc: // Set panning (0..F maps to 0..255 in steps of 0x11).
        v.panning = lo * 17;
        break;
      case 0xf: // Tone portamento (param * 16; no memory)
        if (lo !== 0) v.portaSpeed = lo * 16;
        break;
      default:
        break;
    }
  }

  private applyVolumeColumnPerTick(channel: number, byte: number): void {
    if (byte === 0) return;
    const v = this.voices[channel]!;
    const hi = (byte >>> 4) & 0xf;
    const lo = byte & 0xf;
    switch (hi) {
      case 0x6:
        // Vol slide down per tick.
        v.volume = Math.max(0, v.volume - lo);
        break;
      case 0x7:
        // Vol slide up per tick.
        v.volume = Math.min(64, v.volume + lo);
        break;
      case 0xb:
        // Vibrato per tick (depth already stashed at tick 0).
        this.runVibrato(v);
        break;
      case 0xd:
        // Pan slide left.
        v.panning = Math.max(0, v.panning - lo);
        break;
      case 0xe:
        // Pan slide right.
        v.panning = Math.min(255, v.panning + lo);
        break;
      case 0xf:
        // Tone porta per tick.
        this.runTonePorta(v);
        break;
      default:
        break;
    }
  }

  // ── Effect column ────────────────────────────────────────────────────

  private applyEffectColumnTick0(channel: number, cell: XmNote): void {
    const v = this.voices[channel]!;
    const x = (cell.effectParam >>> 4) & 0xf;
    const y = cell.effectParam & 0xf;
    switch (cell.effect) {
      case 0x00:
        // Arpeggio. XM has no QUIRK_ARPMEM — every empty cell (effect
        // 0 + param 0) clears the arp memory. So `v.arpParam` is
        // unconditionally seeded from this row's cell.effectParam,
        // wiping any prior arpeggio when the song moves to a non-arp
        // row. The actual pitch offset goes onto `v.arpOffset` in the
        // per-tick handler; period stays untouched here.
        v.arpParam = cell.effectParam;
        break;
      case 0x01:
        // Slide up — memory.
        if (cell.effectParam !== 0) v.slideUpLast = cell.effectParam;
        break;
      case 0x02:
        if (cell.effectParam !== 0) v.slideDownLast = cell.effectParam;
        break;
      case 0x03:
        // Tone porta — speed memory only.
        if (cell.effectParam !== 0) v.portaSpeed = cell.effectParam;
        break;
      case 0x04:
        // Vibrato — speed / depth memory.
        if (x !== 0) v.vibSpeed = x;
        if (y !== 0) v.vibDepth = y;
        break;
      case 0x05:
        // Tone porta + vol slide — memory belongs to Axy.
        if (cell.effectParam !== 0) v.volSlideLast = cell.effectParam;
        break;
      case 0x06:
        // Vibrato + vol slide.
        if (cell.effectParam !== 0) v.volSlideLast = cell.effectParam;
        break;
      case 0x07:
        // Tremolo — speed / depth memory.
        if (x !== 0) v.tremSpeed = x;
        if (y !== 0) v.tremDepth = y;
        break;
      case 0x08:
        v.panning = cell.effectParam;
        break;
      case 0x09: {
        // Sample offset: param * 256 bytes (≈ samples for 8-bit; for 16-bit
        // ft2-clone treats the param the same — the offset is in samples,
        // not bytes, despite the name). Empty param uses the last value.
        const p =
          cell.effectParam === 0 ? v.sampleOffsetLast : cell.effectParam;
        if (cell.effectParam !== 0) v.sampleOffsetLast = cell.effectParam;
        // Only meaningful if a note just triggered on this row — the
        // playing voice is already at pos 0 in that case.
        if (cell.note > 0 && cell.note <= 96 && v.playing && v.sample) {
          v.pos = p * 256;
          if (v.pos >= v.sample.data.length) v.playing = false;
        }
        break;
      }
      case 0x0a:
        if (cell.effectParam !== 0) v.volSlideLast = cell.effectParam;
        break;
      case 0x0b: // Bxx
        this.state.jumpToOrder = cell.effectParam;
        this.state.jumpToRow = 0;
        break;
      case 0x0c: // Cxx
        v.volume = Math.min(64, cell.effectParam);
        break;
      case 0x0d: {
        const p = cell.effectParam;
        this.state.jumpToRow = (p >>> 4) * 10 + (p & 0x0f);
        break;
      }
      case 0x0e:
        this.applyExtendedTick0(channel, x, y);
        break;
      case 0x0f: {
        const p = cell.effectParam;
        if (p === 0) {
          if (!this.loop && !this.loopPattern) this.state.ended = true;
        } else if (p < 32) {
          this.state.speed = p;
        } else {
          this.state.tempo = p;
        }
        break;
      }
      case 0x10: // Gxx — set global volume
        this.state.globalVolume = Math.min(64, cell.effectParam);
        break;
      case 0x11: // Hxy — global vol slide memory
        if (cell.effectParam !== 0)
          this.state.globalVolSlideLast = cell.effectParam;
        break;
      case 0x14: // Kxx — same as note 97.
        this.applyKeyOff(v);
        break;
      case 0x15: // Lxx — set envelope position to xx.
        v.volEnvPos = cell.effectParam;
        v.panEnvPos = cell.effectParam;
        break;
      case 0x19: // Pxy — pan slide memory
        if (cell.effectParam !== 0) v.panSlideLast = cell.effectParam;
        break;
      case 0x1b: // Rxy — multi-retrigger setup
        if (x !== 0) v.retrigVolChange = x;
        if (y !== 0) v.retrigInterval = y;
        break;
      case 0x21:
        this.applyXExtendedTick0(channel, x, y);
        break;
      default:
        break;
    }
  }

  private applyExtendedTick0(channel: number, sub: number, y: number): void {
    const v = this.voices[channel]!;
    switch (sub) {
      case 0x1:
        // Fine slide up — period decreases (pitch up).
        v.period = clampPeriod(v.period - y * 4, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      case 0x2:
        v.period = clampPeriod(v.period + y * 4, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      case 0x3:
        // Glissando control: any non-zero value turns it on.
        v.glissando = y !== 0;
        break;
      case 0x4:
        v.vibWaveform = y;
        break;
      case 0x5: {
        // Set finetune — rewrite the voice period from the current
        // effective note + new finetune.
        const ft = (y - 8) * 16;
        if (v.effectiveNote > 0) {
          v.period = periodForNote(v.effectiveNote, ft, this.linearFreq);
          v.finetune = ft;
          v.glissPeriod = 0;
          v.vibOffset = 0;
        }
        break;
      }
      case 0x6:
        // Pattern loop (ft2-clone `patternLoop`). E60 marks the start row;
        // E6y loops back y times. The counter is per channel, so loops on
        // different channels run independently.
        if (y === 0) {
          v.patLoopStartRow = this.state.row;
        } else if (v.patLoopCounter === 0) {
          v.patLoopCounter = y;
          this.state.loopJumpRow = v.patLoopStartRow;
        } else if (--v.patLoopCounter > 0) {
          this.state.loopJumpRow = v.patLoopStartRow;
        }
        break;
      case 0x7:
        v.tremWaveform = y;
        break;
      case 0x8:
        v.panning = y * 16;
        break;
      case 0xa:
        v.volume = Math.min(64, v.volume + y);
        break;
      case 0xb:
        v.volume = Math.max(0, v.volume - y);
        break;
      case 0xc:
        v.noteCutAt = y;
        if (y === 0) v.volume = 0;
        break;
      case 0xd:
        // Note delay (Slice handled in processCell where we know the cell).
        break;
      case 0xe:
        // Pattern delay: play this row y more times. Tick-0 effects only run
        // on the first pass, so a repeat can never re-arm the delay; with
        // EEy on several channels the last one wins, as in FT2.
        this.state.patternDelayRepeats = y;
        break;
      default:
        break;
    }
  }

  private applyXExtendedTick0(channel: number, sub: number, y: number): void {
    const v = this.voices[channel]!;
    switch (sub) {
      case 0x1: // Extra-fine slide up
        v.period = clampPeriod(v.period - y, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      case 0x2:
        v.period = clampPeriod(v.period + y, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      default:
        break;
    }
  }

  // ── Per-tick effect runner (tick 1, 2, …) ────────────────────────────

  private runContinuousEffects(): void {
    const patIdx = this.song.orders[this.state.orderIndex] ?? 0;
    const pat = this.song.patterns[patIdx];
    if (!pat) return;
    const row = pat.rows[this.state.row];
    if (!row) return;
    const tick = this.state.tickInRow;
    for (let c = 0; c < this.voices.length && c < row.length; c++) {
      const cell = row[c]!;
      const v = this.voices[c]!;
      // Deferred-trigger handlers (note delay / note cut).
      if (v.noteDelayAt === tick) {
        this.applyNoteInstrument(
          c,
          { ...cell, note: v.noteDelayNote, instrument: v.noteDelayInst },
          false,
        );
        // Also re-apply the volume column on the trigger tick.
        this.applyVolumeColumnTick0(c, cell.volumeColumn);
        v.noteDelayAt = -1;
      }
      if (v.noteCutAt === tick && tick > 0) v.volume = 0;
      // Volume column per-tick.
      this.applyVolumeColumnPerTick(c, cell.volumeColumn);
      // Effect column per-tick.
      this.applyEffectColumnPerTick(c, cell);
    }
  }

  private applyEffectColumnPerTick(channel: number, cell: XmNote): void {
    const v = this.voices[channel]!;
    const x = (cell.effectParam >>> 4) & 0xf;
    const y = cell.effectParam & 0xf;
    switch (cell.effect) {
      case 0x00: {
        // Arpeggio: tick%3 cycles between base / +x / +y semitones.
        // We write to `v.arpOffset` (a semitone offset, reset to 0 at
        // the top of each tick); the period stays unchanged. The
        // arpOffset is folded into the mixer period in
        // `syncVoiceSteps`, mirroring libxmp's "arp is an additive
        // pitch offset, not a write into xc->period" architecture.
        if (v.arpParam === 0 || v.effectiveNote === 0) break;
        const phase = this.state.tickInRow % 3;
        const ax = (v.arpParam >>> 4) & 0xf;
        const ay = v.arpParam & 0xf;
        v.arpOffset = phase === 1 ? ax : phase === 2 ? ay : 0;
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      }
      case 0x01:
        v.period = clampPeriod(v.period - v.slideUpLast * 4, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      case 0x02:
        v.period = clampPeriod(v.period + v.slideDownLast * 4, this.linearFreq);
        v.glissPeriod = 0;
        v.vibOffset = 0;
        break;
      case 0x03:
        this.runTonePorta(v);
        break;
      case 0x04:
        this.runVibrato(v);
        break;
      case 0x05:
        this.runTonePorta(v);
        this.runVolSlide(v, v.volSlideLast);
        break;
      case 0x06:
        this.runVibrato(v);
        this.runVolSlide(v, v.volSlideLast);
        break;
      case 0x07:
        this.runTremolo(v);
        break;
      case 0x0a:
        this.runVolSlide(v, v.volSlideLast);
        break;
      case 0x0e:
        // E-extended per-tick: E9y retrigger, ECy/EDy land via the
        // deferred-trigger handlers above. Nothing else fires per-tick.
        if (((cell.effectParam >>> 4) & 0xf) === 0x9 && y !== 0) {
          if (this.state.tickInRow % y === 0 && this.state.tickInRow > 0) {
            // Retrigger: rewind sample position, keep volume.
            if (v.sample) {
              v.pos = 0;
              v.looped = false;
            }
          }
        }
        break;
      case 0x11: {
        // Hxy global vol slide. Memory is global (libxmp `gvol.memory`),
        // independent of per-voice Axy memory.
        const sx = (this.state.globalVolSlideLast >>> 4) & 0xf;
        const sy = this.state.globalVolSlideLast & 0xf;
        if (sx !== 0) {
          this.state.globalVolume = Math.min(64, this.state.globalVolume + sx);
        } else if (sy !== 0) {
          this.state.globalVolume = Math.max(0, this.state.globalVolume - sy);
        }
        break;
      }
      case 0x19: {
        // Pxy pan slide. libxmp effects.c:648 — `pan.slide = LSN(fxp) - MSN(fxp)`:
        // both nibbles apply simultaneously, low (y) adds (right), high (x)
        // subtracts (left). Net delta is `y - x`, then clamped to [0, 255].
        const sx = (v.panSlideLast >>> 4) & 0xf;
        const sy = v.panSlideLast & 0xf;
        v.panning = Math.max(0, Math.min(255, v.panning + sy - sx));
        break;
      }
      case 0x1d:
        this.runTremor(v, cell.effectParam);
        break;
      case 0x1b:
        // Rxy multi-retrigger.
        if (
          v.retrigInterval > 0 &&
          this.state.tickInRow % v.retrigInterval === 0
        ) {
          if (v.sample) {
            v.pos = 0;
            v.looped = false;
          }
          this.applyRetrigVolChange(v);
        }
        break;
      default:
        break;
    }
    // Per-tick is intentionally idempotent w.r.t. x/y: tick-0 stashes
    // the memory and the per-tick functions read the voice's saved
    // values. The `x` shadow above is only used by the few effects that
    // genuinely vary per tick (arp).
    void x;
  }

  private applyRetrigVolChange(v: XmVoice): void {
    // ft2-clone uses a 16-entry table here; the four common values are:
    //   1 = -1, 2 = -2, 3 = -4, 4 = -8, 5 = -16
    //   6 = ×2/3, 7 = ×1/2
    //   9..D = +1, +2, +4, +8, +16
    //   E = ×3/2, F = ×2
    const code = v.retrigVolChange;
    switch (code) {
      case 0:
        break;
      case 1:
        v.volume = Math.max(0, v.volume - 1);
        break;
      case 2:
        v.volume = Math.max(0, v.volume - 2);
        break;
      case 3:
        v.volume = Math.max(0, v.volume - 4);
        break;
      case 4:
        v.volume = Math.max(0, v.volume - 8);
        break;
      case 5:
        v.volume = Math.max(0, v.volume - 16);
        break;
      case 6:
        v.volume = Math.floor((v.volume * 2) / 3);
        break;
      case 7:
        v.volume = Math.floor(v.volume / 2);
        break;
      case 9:
        v.volume = Math.min(64, v.volume + 1);
        break;
      case 0xa:
        v.volume = Math.min(64, v.volume + 2);
        break;
      case 0xb:
        v.volume = Math.min(64, v.volume + 4);
        break;
      case 0xc:
        v.volume = Math.min(64, v.volume + 8);
        break;
      case 0xd:
        v.volume = Math.min(64, v.volume + 16);
        break;
      case 0xe:
        v.volume = Math.min(64, Math.floor((v.volume * 3) / 2));
        break;
      case 0xf:
        v.volume = Math.min(64, v.volume * 2);
        break;
      default:
        break;
    }
  }

  private runTonePorta(v: XmVoice): void {
    if (v.portaTarget === 0 || v.portaSpeed === 0) return;
    const step = v.portaSpeed * 4;
    if (v.period < v.portaTarget) {
      v.period = Math.min(v.portaTarget, v.period + step);
    } else if (v.period > v.portaTarget) {
      v.period = Math.max(v.portaTarget, v.period - step);
    }
    v.glissPeriod = v.glissando ? this.semitonePeriod(v) : 0;
    v.vibOffset = 0;
  }

  /**
   * Round the voice's period to a whole semitone for glissando — a port of
   * ft2-clone's `period2NotePeriod`. It binary-searches the notes for the
   * highest one whose half-semitone-below boundary is still above the
   * period, so the pitch snaps to the nearest note, and an exact halfway
   * tie goes to the lower note. Finetune is honoured at FT2's 1/16-semitone
   * resolution so the steps land on the sample's own tuning.
   */
  private semitonePeriod(v: XmVoice): number {
    const finetune = (v.finetune >> 3) * 8;
    let lo = 0;
    let hi = 8 * 12; // FT2 searches 8 octaves, not the full 10.
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) >> 1;
      // 64 finetune units = half a semitone.
      const boundary = periodForNote(mid + 1, finetune - 64, this.linearFreq);
      if (v.period >= boundary) hi = mid;
      else lo = mid;
    }
    return periodForNote(lo + 1, finetune, this.linearFreq);
  }

  /**
   * Txy tremor, one call per non-zero tick (ft2-clone `tremor`): the voice
   * sounds for x+1 ticks, then is silent for y+1, and so on. The phase
   * carries across rows and is only reset by a note trigger. T00 reuses
   * the last parameter.
   */
  private runTremor(v: XmVoice, param: number): void {
    if (param === 0) param = v.tremorParam;
    v.tremorParam = param;
    let on = (v.tremorPos & 0x80) !== 0;
    let left = (v.tremorPos & 0x7f) - 1;
    if (left < 0) {
      on = !on;
      left = on ? param >>> 4 : param & 0x0f;
    }
    v.tremorPos = (on ? 0x80 : 0) | left;
    v.tremorMuted = !on;
  }

  /**
   * One vibrato step (ft2-clone `doVibrato`): the pitch offset is
   * `magnitude * depth >> 5` period units, added in the first half-cycle
   * (pitch down) and subtracted in the second. Depth F on a sine swings
   * about ±1.9 semitones in linear mode.
   */
  private runVibrato(v: XmVoice): void {
    const secondHalf = (v.vibPos & 0x20) !== 0;
    const delta =
      (lfoMagnitude(v.vibPos, v.vibWaveform, secondHalf) * v.vibDepth) >> 5;
    v.vibOffset = secondHalf ? -delta : delta;
    v.glissPeriod = 0;
    v.vibPos = (v.vibPos + v.vibSpeed) & 0x3f;
  }

  /**
   * One tremolo step (ft2-clone `tremolo`): `magnitude * depth >> 6` volume
   * units, added in the first half-cycle and subtracted in the second,
   * clamped to 0..64. The ramp waveform is mirrored by the *vibrato*
   * phase, not the tremolo one — an FT2 bug that modules have been written
   * against.
   */
  private runTremolo(v: XmVoice): void {
    const vibSecondHalf = (v.vibPos & 0x20) !== 0;
    const delta =
      (lfoMagnitude(v.tremPos, v.tremWaveform, vibSecondHalf) * v.tremDepth) >>
      6;
    const base = v.volume;
    v.tremorMuted = false;
    v.effectiveVolume =
      (v.tremPos & 0x20) !== 0
        ? Math.max(0, base - delta)
        : Math.min(64, base + delta);
    v.tremPos = (v.tremPos + v.tremSpeed) & 0x3f;
  }

  private runVolSlide(v: XmVoice, param: number): void {
    if (param === 0) return;
    const x = (param >>> 4) & 0xf;
    const y = param & 0xf;
    if (x !== 0) v.volume = Math.min(64, v.volume + x);
    else if (y !== 0) v.volume = Math.max(0, v.volume - y);
  }

  // ── Mixer ────────────────────────────────────────────────────────────

  private mixChunk(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    frames: number,
  ): void {
    for (let i = 0; i < frames; i++) {
      left[offset + i] = 0;
      right[offset + i] = 0;
    }
    for (let c = 0; c < this.voices.length; c++) {
      const v = this.voices[c]!;
      // Discharge curve runs BEFORE the voice mix — even if the voice
      // has stopped playing (sample fell off the end), the quadratic
      // decay of its last sample still needs to land in the buffer.
      if (v.pendingDischarge) {
        this.applyDischarge(v, left, right, offset, frames);
        v.pendingDischarge = false;
      }
      if (!v.playing || !v.sample) continue;
      // A muted channel still runs mixVoice to advance the read position
      // (matches the "DMA continues normally so unmuting picks up
      // wherever the song would be" semantics), but with zero target
      // gains. The cheap path: skip mixing entirely.
      if (this.channelMuted[c]) {
        // Advance position without mixing so silence resumes cleanly
        // when the user unmutes. The gains are 0 for as long as the
        // channel stays muted (snapshotTickGains computes 0).
        this.advanceVoicePos(v, frames);
        continue;
      }
      this.mixVoice(v, left, right, offset, frames);
    }
  }

  /**
   * libxmp's `do_anticlick` discharge curve: add a quadratic decay of
   * the voice's last contributed sample to the buffer for up to
   * `ticksize >> 3` samples. Removes the click that the gain ramp
   * alone can't fully suppress on retrigger.
   *
   * The decay shape matches libxmp's integer math: stepmul decreases
   * linearly from `stepval * count` to 0; the contribution at each
   * sample is `sleft * (stepmul / 2^FPSHIFT)^2`. ANTICLICK_FPSHIFT is
   * 24 in libxmp; we work in float so the shifts don't matter — the
   * shape is what counts.
   */
  private applyDischarge(
    v: XmVoice,
    left: Float32Array,
    right: Float32Array,
    offset: number,
    frames: number,
  ): void {
    const sleft = v.sleft;
    const sright = v.sright;
    v.sleft = 0;
    v.sright = 0;
    if (sleft === 0 && sright === 0) return;
    const discharge = Math.max(
      1,
      this.currentTickSamples >> XmReplayer.ANTICLICK_SHIFT,
    );
    const count = Math.min(discharge, frames);
    for (let i = 0; i < count; i++) {
      // Quadratic decay from ~1 → 0 over `count` samples.
      const t = (count - i - 1) / count;
      const decay = t * t;
      const oi = offset + i;
      left[oi] = (left[oi] ?? 0) + sleft * decay;
      right[oi] = (right[oi] ?? 0) + sright * decay;
    }
  }

  /**
   * Advance the voice's double `pos` by `frames` output samples
   * without writing audio. Mirrors the position-update math of
   * `mixVoice` exactly — muted channels still walk the sample data so
   * a future unmute lands in the right place.
   */
  private advanceVoicePos(v: XmVoice, frames: number): void {
    if (!v.playing || !v.sample) return;
    const samp = v.sample;
    const dataLen = samp.data.length;
    const loopType = samp.loopType;
    const loopStart = samp.loopStart;
    const loopEnd = samp.loopStart + samp.loopLength;
    const hasLoop = loopType !== "none" && samp.loopLength > 0;
    // Forward wrap point: when a loop is active, the voice cycles
    // `[loopStart, loopEnd)` and never reads past `loopEnd` — matches
    // libxmp's mixer.c loop_reposition, which subtracts the loop size
    // at vi->end. For non-looping samples the cutoff is dataLen.
    const endPos = hasLoop ? loopEnd : dataLen;
    let pos = v.pos;
    let stepSigned = v.step * v.direction;
    for (let i = 0; i < frames; i++) {
      pos += stepSigned;
      if (v.direction === 1 && pos >= endPos) {
        if (hasLoop && loopType === "forward") {
          pos = loopStart + ((pos - loopStart) % samp.loopLength);
          v.looped = true;
        } else if (hasLoop && loopType === "ping-pong") {
          v.direction = -1;
          v.looped = true;
          // libxmp's bidir reflection (mixer.c loop_reposition with
          // bidir_adjust = 0 for FT2): pos = 2 * loopEnd - pos.
          pos = 2 * loopEnd - pos;
          if (pos < loopStart) pos = loopStart;
          stepSigned = -v.step;
        } else {
          v.playing = false;
          break;
        }
      } else if (v.direction === -1 && pos < loopStart) {
        if (hasLoop && loopType === "ping-pong") {
          v.direction = 1;
          pos = loopStart + (loopStart - pos);
          if (pos >= loopEnd) pos = loopEnd - 1;
          stepSigned = v.step;
        } else {
          v.playing = false;
          break;
        }
      }
    }
    v.pos = pos;
  }

  private mixVoice(
    v: XmVoice,
    left: Float32Array,
    right: Float32Array,
    offset: number,
    frames: number,
  ): void {
    const samp = v.sample!;
    const data = samp.data;
    const dataLen = data.length;
    // Sample-to-float normalisation. We do libxmp's `(int8 << 8)` shift
    // inline (matches its 16-bit-scale interp range), then divide by
    // 2^15 at the very end so the final amplitude is in the same
    // ±1 ballpark we use everywhere else.
    const sampleShift = samp.bits === 16 ? 0 : 8;
    const loopType = samp.loopType;
    const loopStart = samp.loopStart;
    const loopEnd = samp.loopStart + samp.loopLength;
    const hasLoop = loopType !== "none" && samp.loopLength > 0;
    // See advanceVoicePos: with a loop active, the voice cycles
    // `[loopStart, loopEnd)` — never reads past `loopEnd`.
    const endPos = hasLoop ? loopEnd : dataLen;
    let peak = v.peak;
    // Cache the ramp state in locals so the hot loop reads / writes
    // them without going through the voice object each frame.
    let curL = v.currentLGain;
    let curR = v.currentRGain;
    const targetL = v.targetLGain;
    const targetR = v.targetRGain;
    const deltaL = v.rampDeltaL;
    const deltaR = v.rampDeltaR;
    let rampLeft = v.rampLeft;
    // Track the LAST sl/sr we wrote so the discharge curve has
    // something to decay if this voice retriggers next tick.
    let lastSL = 0;
    let lastSR = 0;
    // Voice position as a double — eliminates the long-term sub-
    // sample drift that 16.16 step accumulation produces. The integer
    // / fractional split is re-derived each frame for the libxmp
    // linear-interp math (which is bit-exact in 16-bit-scale int
    // arithmetic).
    let pos = v.pos;
    let stepSigned = v.step * v.direction;
    // Resolved once per chunk; the hot loop branches on small ints.
    // 1 (linear) is the reference path and stays exactly as it was.
    const interp =
      this.interpolation === "none"
        ? 0
        : this.interpolation === "cubic"
          ? 2
          : this.interpolation === "sinc8"
            ? 3
            : 1;
    const pingPong = loopType === "ping-pong";
    const sinc = interp === 3 ? getSincTable() : null;
    for (let i = 0; i < frames; i++) {
      if (!v.playing) break;
      const posInt = Math.floor(pos) | 0;
      const posFrac = ((pos - posInt) * 65536) | 0;
      // libxmp's linear-interp formula, applied in int math (then
      // normalised to float). Operates on the 16-bit-scale sample
      // values so the (frac>>1)*smp_dt expression stays in int32.
      //
      // Loop-wraparound: at the last sample of a forward loop the
      // "next sample" for interp is data[loopStart], not the (out-of-
      // loop) data[posInt+1]. libxmp does this via init_sample_wrap_
      // around; we compute it inline. For ping-pong at loopEnd-1 the
      // "next sample" is the same sample (the LFO direction is about
      // to flip), so we re-use data[posInt]. Non-looping samples just
      // repeat the last value at end-of-data.
      const s0 = (data[posInt] ?? 0) << sampleShift;
      let s1Raw: number;
      // Loop-wraparound: the only direction-agnostic boundary is the
      // forward end of the loop. At posInt == loopEnd - 1 the partner
      // sample at posInt + 1 is out of range — for forward loops it
      // wraps to data[loopStart]; for ping-pong it mirrors back to
      // data[loopEnd - 1] (same as s0). This applies in BOTH directions:
      // immediately after a forward→reverse reflection in a ping-pong
      // sample we can land at posInt == loopEnd - 1 with direction = -1,
      // and the partner is still the reflected mirror, not the
      // out-of-bounds data[loopEnd].
      if (hasLoop && posInt >= loopEnd - 1) {
        s1Raw =
          loopType === "ping-pong"
            ? (data[posInt] ?? 0)
            : (data[loopStart] ?? 0);
      } else {
        s1Raw = data[posInt + 1] ?? data[posInt] ?? 0;
      }
      const s1 = s1Raw << sampleShift;
      const smpDt = s1 - s0;
      // (posFrac >> 1) * smpDt fits in int32: posFrac>>1 is 0..32767,
      // smpDt is -65535..65535, product is < 2^31.
      let sample: number;
      if (interp === 1) {
        const smpInt = s0 + (((posFrac >> 1) * smpDt) >> 15);
        sample = smpInt / 32768;
      } else if (interp === 0) {
        sample = s0 / 32768;
      } else {
        // `tapAt` is called directly: a per-frame closure here would
        // allocate on the audio thread for every frame of every voice.
        const looped = v.looped;
        if (interp === 2) {
          // 4-point Catmull-Rom through p0..p3, evaluated between p1, p2.
          const t = posFrac / 65536;
          const p0 =
            tapAt(
              data,
              posInt - 1,
              hasLoop,
              pingPong,
              loopStart,
              loopEnd,
              looped,
            ) << sampleShift;
          const p3 =
            tapAt(
              data,
              posInt + 2,
              hasLoop,
              pingPong,
              loopStart,
              loopEnd,
              looped,
            ) << sampleShift;
          const a = -0.5 * p0 + 1.5 * s0 - 1.5 * s1 + 0.5 * p3;
          const b = p0 - 2.5 * s0 + 2 * s1 - 0.5 * p3;
          const c = -0.5 * p0 + 0.5 * s1;
          sample = (((a * t + b) * t + c) * t + s0) / 32768;
        } else {
          const row = (posFrac >> 8) * SINC_TAPS;
          let acc = 0;
          for (let k = 0; k < SINC_TAPS; k++) {
            acc +=
              (tapAt(
                data,
                posInt + k - 3,
                hasLoop,
                pingPong,
                loopStart,
                loopEnd,
                looped,
              ) <<
                sampleShift) *
              sinc![row + k]!;
          }
          sample = acc / 32768;
        }
      }
      // Choose ramp vs. steady gain. Ramp runs for `rampLeft` samples;
      // once it hits 0 we snap to target to prevent float drift.
      let lGain: number, rGain: number;
      if (rampLeft > 0) {
        lGain = curL;
        rGain = curR;
        curL += deltaL;
        curR += deltaR;
        rampLeft--;
        if (rampLeft === 0) {
          curL = targetL;
          curR = targetR;
        }
      } else {
        lGain = targetL;
        rGain = targetR;
      }
      const sl = sample * lGain;
      const sr = sample * rGain;
      lastSL = sl;
      lastSR = sr;
      const oi = offset + i;
      left[oi] = (left[oi] ?? 0) + sl;
      right[oi] = (right[oi] ?? 0) + sr;
      const absLR = Math.max(Math.abs(sl), Math.abs(sr));
      if (absLR > peak) peak = absLR;
      // Advance pos by the (signed) step. Per-sample loop-wrap check
      // mirrors libxmp's vi->pos advancement — both ours and theirs
      // are in double space here.
      pos += stepSigned;
      if (v.direction === 1 && pos >= endPos) {
        if (hasLoop && loopType === "forward") {
          pos = loopStart + ((pos - loopStart) % samp.loopLength);
          v.looped = true;
        } else if (hasLoop && loopType === "ping-pong") {
          v.direction = -1;
          v.looped = true;
          // libxmp's bidir reflection (mixer.c loop_reposition with
          // bidir_adjust = 0 for FT2): pos = 2 * loopEnd - pos.
          pos = 2 * loopEnd - pos;
          if (pos < loopStart) pos = loopStart;
          stepSigned = -v.step;
        } else {
          v.playing = false;
        }
      } else if (v.direction === -1 && pos < loopStart) {
        if (hasLoop && loopType === "ping-pong") {
          v.direction = 1;
          pos = loopStart + (loopStart - pos);
          if (pos >= loopEnd) pos = loopEnd - 1;
          stepSigned = v.step;
        } else {
          v.playing = false;
        }
      }
    }
    v.peak = peak;
    v.pos = pos;
    // Persist the ramp state so the next chunk (which may still be
    // inside the same tick's ramp window) picks up where we left off.
    v.currentLGain = curL;
    v.currentRGain = curR;
    v.rampLeft = rampLeft;
    // Save the last per-sample contribution so a follow-up retrigger
    // can decay it via `applyDischarge`. We accumulate sleft / sright
    // across mixVoice calls; the discharge handler clears them when
    // it runs (so a single mix call's worth of "last sample" is what
    // ends up decayed).
    v.sleft = lastSL;
    v.sright = lastSR;
  }

  // Touch `hzForNote` so the import stays live — used by the linear-mode
  // path in tests via `xmFreqTable`. (Internal computations go through
  // `hzForPeriod` for performance.)
  static _hzForNote = hzForNote;
}
