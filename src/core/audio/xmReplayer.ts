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
 *     9xx sample offset, Axy vol slide, Exy E-extended (E1y, E2y, E4y,
 *     E5y, E7y, E8y, E9y, EAy, EBy, ECy, EDy), Gxx global vol, Hxy
 *     global vol slide, Kxx key off (silence for now — full envelope
 *     release lands in Slice 3), Pxy pan slide, Rxy multi-retrigger,
 *     Xxy X-extended (X1y / X2y extra-fine slides).
 *   - Volume column: 6 (slide down), 7 (slide up), 8 (fine slide down),
 *     9 (fine slide up), A (set vib speed), B (vibrato), C (set pan),
 *     D (pan slide left), E (pan slide right), F (tone porta speed).
 *
 * Not yet wired (Slice 3+):
 *   - Volume / panning envelopes
 *   - Fadeout
 *   - Autovibrato
 *   - Multi-sample instruments (keyMap is read but always-zero in Phase 3)
 *   - Note 97 properly releasing the envelope (currently silences voice)
 *
 * Reference for behaviour: 8bitbubsy/ft2-clone (`src/ft2_replayer.c`).
 */

import type { Song } from "../song";
import type { Sample } from "../mod/types";
import type { XmInstrument, XmNote, XmSample, XmSong } from "../xm/types";
import type { ReplayerOptions } from "./types";
import { hzForNote, periodForNote } from "./xmFreqTable";

/** XM uses an 8-byte signed-ish sine table scaled to ±64 for vibrato/tremolo. */
const XM_VIBRATO_TABLE = (() => {
  const t = new Int8Array(32);
  for (let i = 0; i < 32; i++) {
    t[i] = Math.round(64 * Math.sin((i * Math.PI) / 32));
  }
  return t;
})();

/**
 * Autovibrato waveform sampler. Phase is a full byte (0..255) and the
 * waveform enum mirrors ft2-clone's `vibtab` layout: 0 = sine, 1 = ramp
 * down, 2 = square, 3 = ramp up. Returns a signed -64..63 value.
 */
function autoVibratoWaveform(
  pos: number,
  type: import("../xm/types").XmAutoVibratoType,
): number {
  const p = pos & 0xff;
  switch (type) {
    case "sine":
      return Math.round(64 * Math.sin((p * 2 * Math.PI) / 256));
    case "ramp-down":
      // Linear -64 → 63 across the period.
      return ((p < 128 ? -p : 256 - p) * 64) >> 7;
    case "ramp-up":
      return ((p < 128 ? p : p - 256) * 64) >> 7;
    case "square":
      return p < 128 ? 64 : -64;
    default:
      return 0;
  }
}

/** Read XM_VIBRATO_TABLE in the waveform the user selected via E4y / E7y. */
function vibValue(pos: number, waveform: number): number {
  const phase = pos & 0x3f; // 0..63
  switch (waveform & 3) {
    case 0: {
      // Sine — symmetric around 0.
      const v = XM_VIBRATO_TABLE[phase & 0x1f]!;
      return phase < 32 ? v : -v;
    }
    case 1:
      // Ramp down (saw): linear -64..63.
      return ((phase * 2) & 0xff) > 127
        ? ((phase * 2) & 0xff) - 256
        : (phase * 2) & 0xff;
    case 2:
      // Square — alternates ±64.
      return phase < 32 ? 64 : -64;
    default:
      // ft2-clone treats waveform 3 as "random" → noise. Tests don't need
      // determinism here; return a sine value to keep playback audible.
      return XM_VIBRATO_TABLE[phase & 0x1f]!;
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
  /** Voice volume 0..64 (XM-native). Updated by Cxy, Axy, vol-col 1..5/6/7/8/9, EAy/EBy. */
  volume: number;
  /** Panning 0..255 (0 = left, 128 = center, 255 = right). */
  panning: number;
  /** Effective volume after tremolo (or -1 for "no override"). */
  effectiveVolume: number;
  /** Note number that triggered the voice (1..96), 0 when silent. */
  note: number;
  /** Effective note after relativeNote applied. */
  effectiveNote: number;
  /** Instrument number 1..128 that produced the voice, 0 when silent. */
  instrument: number;
  /** Current pitch period (signed; smaller = higher pitch). */
  period: number;
  /** Tone-porta target period. */
  portaTarget: number;
  /** Last seen porta speed (3xx memory; persists across rows). */
  portaSpeed: number;
  /** Vibrato state. */
  vibSpeed: number;
  vibDepth: number;
  vibPos: number; // 0..63
  vibWaveform: number; // 0..3
  /** Tremolo state. */
  tremSpeed: number;
  tremDepth: number;
  tremPos: number;
  tremWaveform: number;
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
   * Folded into the mixer period in `syncVoiceSteps`. Mirrors
   * libxmp's `linear_bend = period + vibrato` pattern — vibrato never
   * mutates the persistent base period, so a row that doesn't carry
   * vibrato reverts to clean pitch immediately.
   */
  vibOffset: number;
  /** Multi-retrigger Rxy memory. */
  retrigInterval: number;
  retrigVolChange: number;
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
  /**
   * Autovibrato LFO phase (0..255). Advances by `instrument.vibratoRate`
   * each tick. Independent of the 4xy effect column vibrato.
   */
  autoVibPos: number;
  /**
   * Sweep ramp-in counter. Counts up from 0 to `instrument.vibratoSweep`;
   * the effective depth scales linearly across this range so a fresh note
   * eases into its autovibrato instead of starting at full depth.
   */
  autoVibSweepPos: number;
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
    volume: 0,
    panning: 128,
    effectiveVolume: -1,
    note: 0,
    effectiveNote: 0,
    instrument: 0,
    period: 0,
    portaTarget: 0,
    portaSpeed: 0,
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
    noteCutAt: -1,
    noteDelayAt: -1,
    noteDelayNote: 0,
    noteDelayInst: 0,
    keyOff: false,
    autoVibPos: 0,
    autoVibSweepPos: 0,
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
  // Amiga period range: 113..856 in PT; allow wider in XM for ramp extremes.
  return Math.max(1, Math.min(32767, p));
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

  constructor(song: Song, opts: ReplayerOptions) {
    if (song.format !== "FT2") {
      throw new Error("XmReplayer: expected FT2 song");
    }
    this.song = song;
    this.sampleRate = opts.sampleRate;
    this.loop = opts.loop ?? false;
    this.loopPattern = opts.loopPattern ?? false;
    this.linearFreq = song.flags.linearFreq;
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
    // Clear per-tick effective volume so the next mix reads `volume`
    // unless tremolo overrides it on this tick. Same for arp offset:
    // the per-tick handler sets it from arpParam if the current row
    // is an arp row, otherwise it stays at 0 so the mixer plays the
    // unmodified period.
    for (const v of this.voices) {
      v.effectiveVolume = -1;
      v.arpOffset = 0;
      v.vibOffset = 0;
    }
    if (this.state.tickInRow >= this.state.speed) {
      this.state.tickInRow = 0;
      this.advanceRow();
      if (this.state.ended) return;
      this.processRow();
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
      // Autovibrato: advance phase + sweep counter so the offset
      // computed in syncVoiceSteps reflects the new tick. Only counts
      // when the instrument actually has autovibrato configured.
      if (inst.vibratoRate > 0 && inst.vibratoDepth > 0) {
        v.autoVibPos = (v.autoVibPos + inst.vibratoRate) & 0xff;
        if (v.autoVibSweepPos < inst.vibratoSweep) v.autoVibSweepPos++;
      }
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
    const voiceVol = v.effectiveVolume >= 0 ? v.effectiveVolume : v.volume;
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
      // No-change → no ramp; saves work in mixVoice's hot loop.
      if (v.currentLGain === tL && v.currentRGain === tR) {
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
      // Overlay autovibrato as a per-tick pitch offset. The base period
      // (`v.period`) is unchanged — slides keep working — and the offset
      // is recomputed at every tick so it tracks the LFO phase.
      const autoVibOffset = this.autoVibratoOffset(v);
      // Arpeggio offset (semitones) → period offset. In linear mode
      // one semitone = 16 period units, and raising pitch *lowers*
      // period. ft2-clone / libxmp work the same way: arp offsets are
      // pitch-up, so we subtract 16 * semitones from the period.
      // Amiga mode uses the same direction; the per-semitone period
      // change isn't a constant 16 but the linear-mode formula is
      // good enough for the audible-pitch range.
      const arpPeriodOffset = this.linearFreq
        ? -v.arpOffset * 16 * 4
        : -v.arpOffset * 16;
      const effectivePeriod = clampPeriod(
        v.period + autoVibOffset + arpPeriodOffset + v.vibOffset,
        this.linearFreq,
      );
      const hz = this.hzForPeriod(effectivePeriod);
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

  /**
   * Per-tick autovibrato: depth ramps in over `vibratoSweep` ticks, then
   * holds at full depth. Phase advances by `vibratoRate` each tick.
   * Returns a signed period offset (small numbers; in linear-mode period
   * units, ±a few semitones at full depth).
   */
  private autoVibratoOffset(v: XmVoice): number {
    const inst = v.envInstrument;
    if (!inst) return 0;
    if (inst.vibratoDepth === 0 || inst.vibratoRate === 0) return 0;
    // Sweep-scaled depth. When sweep === 0 the depth is full from tick 0.
    const sweep = inst.vibratoSweep;
    const scaledDepth =
      sweep > 0
        ? (inst.vibratoDepth * Math.min(v.autoVibSweepPos, sweep)) / sweep
        : inst.vibratoDepth;
    const raw = autoVibratoWaveform(v.autoVibPos, inst.vibratoType);
    // ft2-clone scales the LFO output by depth / 64. The result is in
    // period units — at full depth (15) the swing is ~±a semitone.
    return (raw * scaledDepth) >> 6;
  }

  private hzForPeriod(period: number): number {
    if (this.linearFreq) {
      // Inverse of `period = 10*12*16*4 - (note-1)*16*4 - finetune/2`
      // through the linear hz formula: Hz = 8363 * 2^((4608 - period) / 768).
      return 8363 * Math.pow(2, (4608 - period) / 768);
    }
    // Amiga: Hz = 8363 * C4_PERIOD / period, with C4_PERIOD = 428 matching
    // periodForNoteAmiga's basePeriodC4. libxmp uses the same constant
    // (mixer.c: `step = C4_PERIOD * c5spd / freq / period`).
    return (8363 * 428) / period;
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
    } else if (this.state.jumpToRow !== -1) {
      nextOrder = this.state.orderIndex + 1;
      nextRow = this.state.jumpToRow;
      this.state.jumpToRow = -1;
    } else {
      const patIdx = this.song.orders[this.state.orderIndex] ?? 0;
      const pat = this.song.patterns[patIdx];
      const rowCount = pat?.rowCount ?? 64;
      if (nextRow >= rowCount) {
        if (this.loopPattern) {
          nextRow = 0;
        } else {
          nextOrder = this.state.orderIndex + 1;
          nextRow = 0;
        }
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
    this.state.orderIndex = nextOrder;
    this.state.row = nextRow;
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
    v.playing = true;
    v.note = note;
    v.effectiveNote = effectiveNote;
    v.instrument = instrumentNumber || v.instrument;
    if (instrumentNumber > 0) {
      v.volume = samp.volume;
      v.panning = samp.panning;
    }
    v.period = periodForNote(effectiveNote, samp.finetune, this.linearFreq);
    v.portaTarget = v.period;
    // Vibrato / tremolo position reset behaviour: ft2-clone resets unless
    // the waveform's high bit is set (E4y / E7y values 4..7). We model the
    // simple case for now — high-bit retain in Slice 3 polish.
    if ((v.vibWaveform & 4) === 0) v.vibPos = 0;
    if ((v.tremWaveform & 4) === 0) v.tremPos = 0;
    v.step = this.hzForPeriod(v.period) / this.sampleRate;
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
    // Autovibrato: phase + sweep ramp restart on every retrigger.
    v.autoVibPos = 0;
    v.autoVibSweepPos = 0;
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
        break;
      case 0x2:
        v.period = clampPeriod(v.period + y * 4, this.linearFreq);
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
        }
        break;
      }
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
      default:
        break;
    }
  }

  private applyXExtendedTick0(channel: number, sub: number, y: number): void {
    const v = this.voices[channel]!;
    switch (sub) {
      case 0x1: // Extra-fine slide up
        v.period = clampPeriod(v.period - y, this.linearFreq);
        break;
      case 0x2:
        v.period = clampPeriod(v.period + y, this.linearFreq);
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
        break;
      }
      case 0x01:
        v.period = clampPeriod(v.period - v.slideUpLast * 4, this.linearFreq);
        break;
      case 0x02:
        v.period = clampPeriod(v.period + v.slideDownLast * 4, this.linearFreq);
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
            if (v.sample) v.pos = 0;
          }
        }
        break;
      case 0x11: {
        // Hxy global vol slide.
        const p =
          v.volSlideLast === 0 ? this.state.globalVolSlideLast : v.volSlideLast;
        void p;
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
      case 0x1b:
        // Rxy multi-retrigger.
        if (
          v.retrigInterval > 0 &&
          this.state.tickInRow % v.retrigInterval === 0
        ) {
          if (v.sample) v.pos = 0;
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
  }

  private runVibrato(v: XmVoice): void {
    if (v.sample === null || v.vibDepth === 0) return;
    const raw = vibValue(v.vibPos, v.vibWaveform);
    // libxmp produces peak depth/2 period units (sine peak 255, depth
    // 0..15, shift 9 ⇒ peak = 255*depth/512 ≈ depth/2). Their period
    // unit is 1/16 semitone; ours is 1/64 (formula `period = 7680 -
    // (note-1)*64`), so the absolute pitch swing matches when we
    // multiply by 4 — equivalent to `>> 5` on our ±64 table.
    v.vibOffset = (raw * v.vibDepth) >> 5;
    // libxmp (player.c:1192): `lfo_update` runs every frame except
    // is_first_frame (frame === 0 for FT2 events). Mirrors `QUIRK_VIBALL`
    // unset for XM — phase advances on all but the song's very first
    // frame. Apply BEFORE advance so the phase used this tick matches
    // libxmp's pre-update read.
    if (this.state.framesElapsed > 0) {
      v.vibPos = (v.vibPos + v.vibSpeed) & 0x3f;
    }
  }

  private runTremolo(v: XmVoice): void {
    if (v.tremDepth === 0) return;
    const raw = vibValue(v.tremPos, v.tremWaveform);
    const offset = (raw * v.tremDepth) >> 6;
    v.effectiveVolume = Math.max(0, Math.min(64, v.volume + offset));
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
        } else if (hasLoop && loopType === "ping-pong") {
          v.direction = -1;
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
      const smpInt = s0 + (((posFrac >> 1) * smpDt) >> 15);
      const sample = smpInt / 32768;
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
        } else if (hasLoop && loopType === "ping-pong") {
          v.direction = -1;
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
