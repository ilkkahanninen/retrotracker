import type { Note, Song } from '../mod/types';
import { CHANNELS, ROWS_PER_PATTERN } from '../mod/types';
import {
  Effect,
  ExtendedEffect,
  PERIOD_TABLE,
} from '../mod/format';
import type { ReplayerOptions } from './types';
import { Paula } from './paula';

/**
 * ProTracker M.K. replayer.
 *
 * Reference behavior: 8bitbubsy/pt2-clone. Pure (no DOM/AudioContext), so the
 * same code drives the offline accuracy test bed and the live AudioWorklet.
 * Mixing is delegated to [Paula] (BLEP synthesis, RC + LED filters, 2× FIR
 * downsample); this file owns tracker logic and the Paula sync.
 *
 * Implemented:
 *   - All standard effects 0xx..Fxx and most Exy
 *   - Hard-panned LRRL with mid/side stereo separation (default 20% per pt2-clone)
 *   - Pattern break / position jump / pattern loop (E6x) / pattern delay (EEx)
 *   - Song-end detection via (order, row) revisit set
 *   - CIA-timer-based tick scheduling with fractional accumulation
 *
 * Not implemented:
 *   - Amiga LED filter (E0x), glissando (E3x), non-sine vibrato (E4x/E7x)
 *   - 8xy panning, EFx invert loop
 */

/** PT sine table — 32 entries, positive half. Sign comes from phase bit 5. */
const SINE_TABLE: readonly number[] = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];

const MIN_PERIOD = 113;
const MAX_PERIOD = 856;
const PT_AMIGA_LIMITS = { min: 113, max: 856 } as const;

interface ChannelState {
  // Active sample
  sampleNum: number;       // 1..31; 0 = none assigned yet
  playing: boolean;        // tracker-side notion of "voice should be live"

  // Pitch
  period: number;          // current effective period (after vibrato)
  basePeriod: number;      // period without vibrato offset
  finetune: number;        // 0..15 (signed nibble encoding)
  noteIndex: number;       // index 0..35 in period table (for arpeggio)

  // Volume
  volume: number;          // 0..64
  effectiveVolume: number; // after tremolo

  // Effect memory
  portToTarget: number;
  portToSpeed: number;
  portamentoSpeed: number;
  vibratoSpeed: number;
  vibratoDepth: number;
  vibratoPos: number;
  tremoloSpeed: number;
  tremoloDepth: number;
  tremoloPos: number;
  volumeSlide: number;     // packed Axx parameter
  arpHi: number;
  arpLo: number;
  sampleOffset: number;
  retrigInterval: number;  // E9y
  noteCutTick: number;     // ECy: -1 = none
  noteDelayTick: number;   // EDy: -1 = none
  pendingNote: Note | null;

  // Pattern loop (per-channel)
  loopRow: number;
  loopCount: number;

  // Paula DMA marshalling
  /** Set when the tracker wants to trigger DMA on the next sync. */
  pendingTrigger: boolean;
  /** Sample-data byte offset at which to start DMA on next trigger (9xy). */
  pendingStartOffsetBytes: number;
  /** Set when the tracker wants to halt DMA on the next sync. */
  pendingStop: boolean;
}

interface SongState {
  speed: number;           // ticks per row
  tempo: number;           // BPM
  tickInRow: number;       // 0..speed-1
  row: number;             // 0..63
  orderIndex: number;
  patternDelay: number;    // EEy: extra row repeats remaining
  jumpToOrder: number;     // -1 = none
  jumpToRow: number;       // -1 = none
  ended: boolean;
  visited: Set<number>;    // (orderIndex << 8 | row) keys
}

function newChannel(): ChannelState {
  return {
    sampleNum: 0,
    playing: false,
    period: 0,
    basePeriod: 0,
    finetune: 0,
    noteIndex: -1,
    volume: 0,
    effectiveVolume: 0,
    portToTarget: 0,
    portToSpeed: 0,
    portamentoSpeed: 0,
    vibratoSpeed: 0,
    vibratoDepth: 0,
    vibratoPos: 0,
    tremoloSpeed: 0,
    tremoloDepth: 0,
    tremoloPos: 0,
    volumeSlide: 0,
    arpHi: 0,
    arpLo: 0,
    sampleOffset: 0,
    retrigInterval: 0,
    noteCutTick: -1,
    noteDelayTick: -1,
    pendingNote: null,
    loopRow: 0,
    loopCount: 0,
    pendingTrigger: false,
    pendingStartOffsetBytes: 0,
    pendingStop: false,
  };
}

export class Replayer {
  private readonly song: Song;
  private readonly sampleRate: number;
  private readonly channels: ChannelState[] = [];
  private readonly state: SongState;
  private readonly paula: Paula;
  /** Mid/side panning side coefficient: (sep% / 100) * 0.5. */
  private readonly sideFactor: number;
  /** Scratch buffers for Paula's double-precision output. */
  private scratchL: Float64Array = new Float64Array(0);
  private scratchR: Float64Array = new Float64Array(0);

  /** Output samples remaining until the next tick boundary. */
  private samplesUntilTick = 0;

  constructor(song: Song, opts: ReplayerOptions) {
    this.song = song;
    this.sampleRate = opts.sampleRate;
    this.paula = new Paula(opts.sampleRate, 'A1200');
    const sep = Math.max(0, Math.min(100, opts.stereoSeparation ?? 20));
    this.sideFactor = (sep / 100) * 0.5;
    for (let i = 0; i < CHANNELS; i++) this.channels.push(newChannel());

    this.state = {
      speed: opts.initialSpeed ?? 6,
      tempo: opts.initialTempo ?? 125,
      tickInRow: 0,
      row: 0,
      orderIndex: 0,
      patternDelay: 0,
      jumpToOrder: -1,
      jumpToRow: -1,
      ended: false,
      visited: new Set(),
    };
    this.samplesUntilTick = this.samplesPerTick();
    this.processRow();
    this.syncPaula();
  }

  process(left: Float32Array, right: Float32Array, frames: number, offset = 0): void {
    if (left.length < offset + frames || right.length < offset + frames) {
      throw new Error('Output buffer too small');
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
        this.samplesUntilTick = this.samplesPerTick();
        if (this.state.ended) continue;
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

  getSampleRate(): number {
    return this.sampleRate;
  }

  // --- scheduling ---------------------------------------------------------

  /**
   * Fractional samples-per-tick accumulator. pt2-clone uses CIA-timer-based
   * tick scheduling: at BPM B, ticks fire at `CIA_PAL_CLK / (floor(1773447/B) + 1)` Hz.
   * That's not exactly `B * 0.4` Hz (49.998 vs 50 at BPM 125), so we track the
   * fractional remainder and add an extra frame periodically.
   */
  private tickFracAccum = 0;
  private static readonly CIA_PAL_CLK = 709379.0; // AMIGA_PAL_CCK_HZ / 5

  private samplesPerTick(): number {
    const ciaPeriod = Math.floor(1773447 / this.state.tempo);
    const tickHz = Replayer.CIA_PAL_CLK / (ciaPeriod + 1);
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
    if (this.state.tickInRow >= this.state.speed) {
      this.state.tickInRow = 0;

      if (this.state.patternDelay > 0) {
        this.state.patternDelay--;
        // Re-process row tick0 effects on each repeat? PT only re-runs row trigger
        // on the original tick0; subsequent repeats just continue effects.
        // Continue effects on each tick of the delay.
        this.runContinuousEffects();
        this.syncPaula();
        return;
      }

      this.advanceRow();
      if (this.state.ended) return;
      this.processRow();
    } else {
      this.runContinuousEffects();
    }
    this.syncPaula();
  }

  /**
   * Push tracker channel state to Paula. Called at every tick boundary,
   * after row/effect processing has settled. Triggers DMA for any channel
   * that requested it; otherwise just updates period/volume on live voices.
   */
  private syncPaula(): void {
    for (let ci = 0; ci < CHANNELS; ci++) {
      const ch = this.channels[ci]!;
      if (ch.pendingStop) {
        this.paula.stopDMA(ci);
        ch.pendingStop = false;
        ch.pendingTrigger = false;
      }
      if (ch.pendingTrigger) {
        const sample = ch.sampleNum > 0 ? this.song.samples[ch.sampleNum - 1] : undefined;
        if (sample && sample.data.byteLength > 0) {
          this.paula.setSample(
            ci,
            sample.data,
            ch.pendingStartOffsetBytes,
            sample.lengthWords,
            sample.loopStartWords * 2,
            sample.loopLengthWords,
          );
          this.paula.setVolume(ci, ch.effectiveVolume || ch.volume);
          this.paula.setPeriod(ci, ch.period);
          this.paula.startDMA(ci);
        }
        ch.pendingTrigger = false;
        ch.pendingStartOffsetBytes = 0;
      } else if (ch.playing) {
        this.paula.setPeriod(ci, ch.period);
        this.paula.setVolume(ci, ch.effectiveVolume || ch.volume);
      }
    }
  }

  private advanceRow(): void {
    if (this.state.jumpToRow >= 0 || this.state.jumpToOrder >= 0) {
      const order = this.state.jumpToOrder >= 0
        ? this.state.jumpToOrder
        : this.state.orderIndex + 1;
      const row = this.state.jumpToRow >= 0 ? this.state.jumpToRow : 0;
      this.state.jumpToOrder = -1;
      this.state.jumpToRow = -1;
      this.gotoOrderRow(order, row);
      return;
    }

    const nextRow = this.state.row + 1;
    if (nextRow < ROWS_PER_PATTERN) {
      this.state.row = nextRow;
    } else {
      this.gotoOrderRow(this.state.orderIndex + 1, 0);
    }
  }

  private gotoOrderRow(order: number, row: number): void {
    if (order >= this.song.songLength) {
      // End of song. PT2 typically loops to restartPosition (or 0).
      // We mark as ended so the caller can stop; the AudioWorklet can choose
      // to loop by reseeking. For tests we want a clear end.
      this.state.ended = true;
      return;
    }
    this.state.orderIndex = order;
    this.state.row = row;

    // Song-end detection via revisit.
    const key = (order << 8) | row;
    if (this.state.visited.has(key)) {
      this.state.ended = true;
      return;
    }
    this.state.visited.add(key);
  }

  // --- per-row handling ---------------------------------------------------

  private currentPattern() {
    const patNum = this.song.orders[this.state.orderIndex] ?? 0;
    return this.song.patterns[patNum];
  }

  private processRow(): void {
    const pattern = this.currentPattern();
    if (!pattern) return;
    const row = pattern.rows[this.state.row];
    if (!row) return;

    for (let c = 0; c < CHANNELS; c++) {
      const note = row[c];
      if (!note) continue;
      this.processChannelRow(c, note);
    }
  }

  private processChannelRow(ci: number, note: Note): void {
    const ch = this.channels[ci]!;
    ch.noteCutTick = -1;
    ch.noteDelayTick = -1;
    ch.pendingNote = null;

    const isToneporta =
      note.effect === Effect.TonePortamento ||
      note.effect === Effect.TonePortamentoVolumeSlide;

    // EDy — note delay. Defer the trigger; just remember it.
    if (note.effect === Effect.Extended && (note.effectParam >> 4) === ExtendedEffect.NoteDelay) {
      const ticks = note.effectParam & 0x0f;
      if (ticks > 0) {
        ch.noteDelayTick = ticks;
        ch.pendingNote = note;
        // Still apply tick-0 effect parameter parsing? In PT, EDy delays the note
        // but other effects on the same row still process on tick 0. We apply
        // effects below as usual.
      }
    }

    // Sample number changes update volume/finetune even without retrigger.
    if (note.sample > 0) {
      const sample = this.song.samples[note.sample - 1];
      if (sample) {
        ch.sampleNum = note.sample;
        ch.volume = sample.volume;
        ch.finetune = sample.finetune;
      }
    }

    // Note trigger (period set).
    if (note.period > 0) {
      const noteIndex = findNoteIndex(note.period, ch.finetune);
      const targetPeriod = noteIndex >= 0
        ? PERIOD_TABLE[ch.finetune]![noteIndex]!
        : note.period;

      if (isToneporta) {
        ch.portToTarget = targetPeriod;
        if (noteIndex >= 0) ch.noteIndex = noteIndex;
      } else if (ch.noteDelayTick < 0) {
        // Immediate trigger.
        ch.basePeriod = targetPeriod;
        ch.period = targetPeriod;
        if (noteIndex >= 0) ch.noteIndex = noteIndex;
        if (ch.sampleNum > 0) {
          ch.pendingTrigger = true;
          ch.pendingStartOffsetBytes = 0;
          ch.playing = true;
        }
        // Reset vibrato/tremolo phase unless the waveform-retain bit is set
        // (E4x/E7x — we don't model the bit yet, so always reset).
        ch.vibratoPos = 0;
        ch.tremoloPos = 0;
      }
    }

    // E5y — set finetune on note trigger.
    if (note.effect === Effect.Extended && (note.effectParam >> 4) === ExtendedEffect.SetFinetune) {
      ch.finetune = note.effectParam & 0x0f;
    }

    // Apply tick-0 effects.
    this.applyTick0Effect(ci, note);
  }

  // --- effects ------------------------------------------------------------

  private applyTick0Effect(ci: number, note: Note): void {
    const ch = this.channels[ci]!;
    const p = note.effectParam;
    const xHi = (p >> 4) & 0x0f;
    const xLo = p & 0x0f;

    switch (note.effect) {
      case Effect.Arpeggio:
        ch.arpHi = xHi;
        ch.arpLo = xLo;
        break;
      case Effect.SlideUp:
        if (p > 0) ch.portamentoSpeed = p;
        break;
      case Effect.SlideDown:
        if (p > 0) ch.portamentoSpeed = p;
        break;
      case Effect.TonePortamento:
        if (p > 0) ch.portToSpeed = p;
        break;
      case Effect.TonePortamentoVolumeSlide:
        if (p > 0) ch.volumeSlide = p;
        break;
      case Effect.Vibrato:
        if (xHi !== 0) ch.vibratoSpeed = xHi;
        if (xLo !== 0) ch.vibratoDepth = xLo;
        break;
      case Effect.VibratoVolumeSlide:
        if (p > 0) ch.volumeSlide = p;
        break;
      case Effect.Tremolo:
        if (xHi !== 0) ch.tremoloSpeed = xHi;
        if (xLo !== 0) ch.tremoloDepth = xLo;
        break;
      case Effect.SetSampleOffset: {
        if (p > 0) ch.sampleOffset = p;
        const offset = ch.sampleOffset * 256;
        const sample = ch.sampleNum > 0 ? this.song.samples[ch.sampleNum - 1] : undefined;
        if (sample && note.period > 0 && ch.pendingTrigger) {
          if (offset < sample.data.byteLength) {
            ch.pendingStartOffsetBytes = offset;
          } else if (sample.loopLengthWords > 1) {
            ch.pendingStartOffsetBytes = sample.loopStartWords * 2;
          } else {
            ch.pendingTrigger = false;
            ch.pendingStop = true;
            ch.playing = false;
          }
        }
        break;
      }
      case Effect.VolumeSlide:
        if (p > 0) ch.volumeSlide = p;
        break;
      case Effect.PositionJump:
        this.state.jumpToOrder = p;
        this.state.jumpToRow = 0;
        break;
      case Effect.SetVolume:
        ch.volume = Math.min(64, p);
        break;
      case Effect.PatternBreak: {
        // xy parameter is decimal: 10*x + y (yes, really)
        const target = xHi * 10 + xLo;
        this.state.jumpToRow = Math.min(target, ROWS_PER_PATTERN - 1);
        if (this.state.jumpToOrder < 0) {
          this.state.jumpToOrder = this.state.orderIndex + 1;
        }
        break;
      }
      case Effect.Extended:
        this.applyExtendedTick0(ci, xHi, xLo);
        break;
      case Effect.SetSpeed:
        if (p === 0) {
          this.state.ended = true;
        } else if (p < 0x20) {
          this.state.speed = p;
        } else {
          this.state.tempo = p;
        }
        break;
    }
  }

  private applyExtendedTick0(ci: number, x: number, y: number): void {
    const ch = this.channels[ci]!;
    switch (x) {
      case ExtendedEffect.FineSlideUp:
        ch.basePeriod = clampPeriod(ch.basePeriod - y);
        ch.period = ch.basePeriod;
        break;
      case ExtendedEffect.FineSlideDown:
        ch.basePeriod = clampPeriod(ch.basePeriod + y);
        ch.period = ch.basePeriod;
        break;
      case ExtendedEffect.PatternLoop:
        if (y === 0) {
          ch.loopRow = this.state.row;
        } else {
          if (ch.loopCount === 0) {
            ch.loopCount = y;
          } else {
            ch.loopCount--;
          }
          if (ch.loopCount > 0) {
            this.state.jumpToOrder = this.state.orderIndex;
            this.state.jumpToRow = ch.loopRow;
          }
        }
        break;
      case ExtendedEffect.Retrigger:
        ch.retrigInterval = y;
        break;
      case ExtendedEffect.FineVolumeSlideUp:
        ch.volume = Math.min(64, ch.volume + y);
        break;
      case ExtendedEffect.FineVolumeSlideDown:
        ch.volume = Math.max(0, ch.volume - y);
        break;
      case ExtendedEffect.NoteCut:
        ch.noteCutTick = y;
        break;
      case ExtendedEffect.PatternDelay:
        if (this.state.patternDelay === 0) this.state.patternDelay = y;
        break;
      // Filter, glissando, waveform, invert loop: no-op.
    }
  }

  private runContinuousEffects(): void {
    const pattern = this.currentPattern();
    const row = pattern?.rows[this.state.row];
    if (!row) return;
    for (let ci = 0; ci < CHANNELS; ci++) {
      const note = row[ci];
      if (!note) continue;
      this.tickEffect(ci, note);
    }
  }

  private tickEffect(ci: number, note: Note): void {
    const ch = this.channels[ci]!;
    const p = note.effectParam;

    // Note delay countdown.
    if (ch.noteDelayTick > 0) {
      ch.noteDelayTick--;
      if (ch.noteDelayTick === 0 && ch.pendingNote) {
        const pending = ch.pendingNote;
        ch.pendingNote = null;
        if (pending.period > 0 && ch.sampleNum > 0) {
          const idx = findNoteIndex(pending.period, ch.finetune);
          const period = idx >= 0 ? PERIOD_TABLE[ch.finetune]![idx]! : pending.period;
          ch.basePeriod = period;
          ch.period = period;
          if (idx >= 0) ch.noteIndex = idx;
          ch.pendingTrigger = true;
          ch.pendingStartOffsetBytes = 0;
          ch.playing = true;
          ch.vibratoPos = 0;
          ch.tremoloPos = 0;
        }
      }
    }

    // Note cut.
    if (ch.noteCutTick > 0) {
      ch.noteCutTick--;
      if (ch.noteCutTick === 0) ch.volume = 0;
    }

    switch (note.effect) {
      case Effect.Arpeggio: {
        if (ch.arpHi === 0 && ch.arpLo === 0) break;
        const phase = this.state.tickInRow % 3;
        let offset = 0;
        if (phase === 1) offset = ch.arpHi;
        else if (phase === 2) offset = ch.arpLo;
        const idx = ch.noteIndex + offset;
        if (idx >= 0 && idx < 36) {
          ch.period = PERIOD_TABLE[ch.finetune]![idx]!;
        }
        if (phase === 0) ch.period = ch.basePeriod;
        break;
      }
      case Effect.SlideUp:
        ch.basePeriod = clampPeriod(ch.basePeriod - ch.portamentoSpeed);
        ch.period = ch.basePeriod;
        break;
      case Effect.SlideDown:
        ch.basePeriod = clampPeriod(ch.basePeriod + ch.portamentoSpeed);
        ch.period = ch.basePeriod;
        break;
      case Effect.TonePortamento:
        this.tickTonePortamento(ch);
        break;
      case Effect.TonePortamentoVolumeSlide:
        this.tickTonePortamento(ch);
        this.tickVolumeSlide(ch);
        break;
      case Effect.Vibrato:
        this.tickVibrato(ch);
        break;
      case Effect.VibratoVolumeSlide:
        this.tickVibrato(ch);
        this.tickVolumeSlide(ch);
        break;
      case Effect.Tremolo:
        this.tickTremolo(ch);
        break;
      case Effect.VolumeSlide:
        this.tickVolumeSlide(ch);
        break;
      case Effect.Extended: {
        const x = (p >> 4) & 0x0f;
        const y = p & 0x0f;
        if (x === ExtendedEffect.Retrigger && y > 0) {
          if (this.state.tickInRow % y === 0 && ch.sampleNum > 0) {
            ch.pendingTrigger = true;
            ch.pendingStartOffsetBytes = 0;
            ch.playing = true;
          }
        }
        break;
      }
    }

    // Vibrato phase advances even while not the current effect? In PT, vibrato
    // runs continuously while the 4xx command is active. We handle it inside
    // the case above (advancement) and only reset basePeriod on tick 0 of a
    // new note. Tremolo similarly.
  }

  private tickVolumeSlide(ch: ChannelState): void {
    const up = (ch.volumeSlide >> 4) & 0x0f;
    const down = ch.volumeSlide & 0x0f;
    if (up > 0) {
      ch.volume = Math.min(64, ch.volume + up);
    } else if (down > 0) {
      ch.volume = Math.max(0, ch.volume - down);
    }
  }

  private tickTonePortamento(ch: ChannelState): void {
    if (ch.portToTarget <= 0 || ch.portToSpeed === 0) return;
    if (ch.basePeriod < ch.portToTarget) {
      ch.basePeriod = Math.min(ch.portToTarget, ch.basePeriod + ch.portToSpeed);
    } else if (ch.basePeriod > ch.portToTarget) {
      ch.basePeriod = Math.max(ch.portToTarget, ch.basePeriod - ch.portToSpeed);
    }
    ch.period = ch.basePeriod;
  }

  private tickVibrato(ch: ChannelState): void {
    const phase = ch.vibratoPos & 31;
    let delta = (SINE_TABLE[phase]! * ch.vibratoDepth) >> 7;
    if (ch.vibratoPos & 32) delta = -delta;
    ch.period = clampPeriod(ch.basePeriod + delta);
    ch.vibratoPos = (ch.vibratoPos + ch.vibratoSpeed) & 63;
  }

  private tickTremolo(ch: ChannelState): void {
    const phase = ch.tremoloPos & 31;
    let delta = (SINE_TABLE[phase]! * ch.tremoloDepth) >> 6;
    if (ch.tremoloPos & 32) delta = -delta;
    ch.effectiveVolume = Math.max(0, Math.min(64, ch.volume + delta));
    ch.tremoloPos = (ch.tremoloPos + ch.tremoloSpeed) & 63;
  }

  // --- mixing -------------------------------------------------------------

  /**
   * Push the current tracker channel state to Paula and emit `frames`
   * output-rate stereo samples. Paula handles BLEP synthesis, RC + LED
   * filters, and 2× FIR downsampling internally; we apply mid/side stereo
   * separation and the final NORM_FACTOR/PAULA_VOICES = 0.5 scaling here.
   */
  private mixChunk(left: Float32Array, right: Float32Array, offset: number, frames: number): void {
    if (this.scratchL.length < frames) {
      this.scratchL = new Float64Array(frames);
      this.scratchR = new Float64Array(frames);
    }
    const sL = this.scratchL;
    const sR = this.scratchR;
    this.paula.generate(sL, sR, frames, 0);

    const side = this.sideFactor;
    for (let i = 0; i < frames; i++) {
      const dL = sL[i]!;
      const dR = sR[i]!;
      const mid = (dL + dR) * 0.5;
      const sideVal = (dL - dR) * side;
      // NORM_FACTOR (2.0) / PAULA_VOICES (4) = 0.5
      left[offset + i]  = (mid + sideVal) * 0.5;
      right[offset + i] = (mid - sideVal) * 0.5;
    }
  }
}

function findNoteIndex(period: number, finetune: number): number {
  const row = PERIOD_TABLE[finetune];
  if (!row) return -1;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === period) return i;
  }
  // No exact match (e.g. portamento landed between table entries). Find nearest.
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < row.length; i++) {
    const d = Math.abs(row[i]! - period);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function clampPeriod(p: number): number {
  if (p < PT_AMIGA_LIMITS.min) return PT_AMIGA_LIMITS.min;
  if (p > PT_AMIGA_LIMITS.max) return PT_AMIGA_LIMITS.max;
  return p;
}

// Re-exports for tests / consumers that want the internal constants.
export const _internals = {
  SINE_TABLE,
  MIN_PERIOD,
  MAX_PERIOD,
};
