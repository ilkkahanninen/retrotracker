import { Show, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { PERIOD_TABLE } from '../core/mod/format';
import type { Cursor } from '../state/cursor';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'] as const;

/**
 * Map a stored Paula period back to its note slot (finetune-0 row, first
 * matching slot scan — same routine pt2-clone uses in setPeriod). Returns
 * null when the period is 0 (no note).
 */
function periodToNoteName(period: number): string | null {
  if (period === 0) return null;
  const row = PERIOD_TABLE[0]!;
  for (let i = 0; i < row.length; i++) {
    if (period >= row[i]!) {
      const oct = 1 + Math.floor(i / 12);
      return `${NOTE_NAMES[i % 12]}${oct}`;
    }
  }
  return '???';
}

/**
 * Break an effect command + parameter byte into a human-readable
 * explanation. `null` means "no effect" (effect=0, param=0). Effects with
 * independent nibbles populate `hi` and `lo`; effects with a combined
 * 8-bit parameter populate `param`. Field naming mirrors PT documentation
 * so a curious user can search for the canonical reference.
 */
interface EffectExplanation {
  /** Display name, e.g. "Vibrato". */
  name: string;
  /** What the high nibble means, when nibbles are independent. */
  hi?: string;
  /** What the low nibble means, when nibbles are independent. */
  lo?: string;
  /** What the whole xx parameter means, when nibbles fuse. */
  param?: string;
}

function explainEffect(effect: number, paramByte: number): EffectExplanation | null {
  if (effect === 0 && paramByte === 0) return null;
  const hi = (paramByte >> 4) & 0xf;
  const lo = paramByte & 0xf;
  switch (effect) {
    case 0x0: return { name: 'Arpeggio', hi: 'halftones up (1st tick)', lo: 'halftones up (2nd tick)' };
    case 0x1: return { name: 'Slide up', param: 'period units / tick' };
    case 0x2: return { name: 'Slide down', param: 'period units / tick' };
    case 0x3: return { name: 'Tone portamento', param: 'slide speed (0 = continue)' };
    case 0x4: return { name: 'Vibrato', hi: 'speed', lo: 'depth' };
    case 0x5: return { name: 'Tone portamento + volume slide', hi: 'volume up', lo: 'volume down' };
    case 0x6: return { name: 'Vibrato + volume slide', hi: 'volume up', lo: 'volume down' };
    case 0x7: return { name: 'Tremolo', hi: 'speed', lo: 'depth' };
    case 0x8: return { name: 'Set panning (ignored in PT 2.3D)', param: 'pan position' };
    case 0x9: return { name: 'Sample offset', param: `start at $${paramByte.toString(16).toUpperCase().padStart(2, '0')}00 bytes` };
    case 0xa: return { name: 'Volume slide', hi: 'volume up', lo: 'volume down' };
    case 0xb: return { name: 'Position jump', param: `to order $${paramByte.toString(16).toUpperCase().padStart(2, '0')}` };
    case 0xc: return { name: 'Set volume', param: `${paramByte} (0..64)` };
    case 0xd: return { name: 'Pattern break', param: `to row ${hi * 10 + lo} (decimal xy)` };
    case 0xe: return explainExtended(hi, lo);
    case 0xf:
      if (paramByte === 0) return { name: 'Stop song', param: 'F00 halts playback' };
      return paramByte < 0x20
        ? { name: 'Set speed', param: `${paramByte} ticks/row` }
        : { name: 'Set tempo', param: `${paramByte} BPM` };
    default:
      return { name: `Effect ${effect.toString(16).toUpperCase()}`, param: 'unknown' };
  }
}

function explainExtended(sub: number, val: number): EffectExplanation {
  const WAVES = ['sine', 'ramp', 'square', 'random'] as const;
  switch (sub) {
    case 0x0: return { name: 'E0x Set filter', param: val === 0 ? 'LED filter off' : 'LED filter on' };
    case 0x1: return { name: 'E1x Fine slide up', param: `${val} period units` };
    case 0x2: return { name: 'E2x Fine slide down', param: `${val} period units` };
    case 0x3: return { name: 'E3x Glissando', param: val === 0 ? 'off' : 'on (snap to halftone)' };
    case 0x4: return { name: 'E4x Vibrato waveform', param: WAVES[val & 3]! };
    case 0x5: return { name: 'E5x Set finetune', param: val < 8 ? `+${val}` : `${val - 16}` };
    case 0x6: return { name: 'E6x Pattern loop', param: val === 0 ? 'set loop point' : `play ${val}× more` };
    case 0x7: return { name: 'E7x Tremolo waveform', param: WAVES[val & 3]! };
    case 0x8: return { name: 'E8x Unused', param: 'no effect' };
    case 0x9: return { name: 'E9x Retrigger', param: `every ${val} ticks` };
    case 0xa: return { name: 'EAx Fine volume up', param: `+${val}` };
    case 0xb: return { name: 'EBx Fine volume down', param: `-${val}` };
    case 0xc: return { name: 'ECx Note cut', param: `at tick ${val}` };
    case 0xd: return { name: 'EDx Note delay', param: `${val} ticks` };
    case 0xe: return { name: 'EEx Pattern delay', param: `${val} rows` };
    case 0xf: return { name: 'EFx Invert loop', param: `speed ${val}` };
    default: return { name: `Extended E${sub.toString(16).toUpperCase()}x`, param: 'unknown' };
  }
}

function effectCellText(note: Note): string {
  if (note.effect === 0 && note.effectParam === 0) return '...';
  const cmd = note.effect.toString(16).toUpperCase();
  const hi = ((note.effectParam >> 4) & 0xf).toString(16).toUpperCase();
  const lo = (note.effectParam & 0xf).toString(16).toUpperCase();
  return `${cmd}${hi}${lo}`;
}

interface Props {
  song: Song;
  cursor: Cursor;
}

/**
 * Inline help pane for the pattern view. Reads the cell under the edit
 * cursor and shows what's there (note, sample, effect breakdown) without
 * the user having to remember PT effect codes. Hidden during playback
 * isn't necessary — the cursor still has a position then; the help just
 * describes wherever it is.
 */
export const PatternHelp: Component<Props> = (props) => {
  const cell = (): Note | null => {
    const patNum = props.song.orders[props.cursor.order];
    if (patNum === undefined) return null;
    const pat = props.song.patterns[patNum];
    if (!pat) return null;
    return pat.rows[props.cursor.row]?.[props.cursor.channel] ?? null;
  };

  const noteName = () => {
    const c = cell();
    return c ? periodToNoteName(c.period) : null;
  };

  const sampleSlot = () => {
    const c = cell();
    return c && c.sample > 0 ? c.sample : null;
  };

  const sampleName = () => {
    const slot = sampleSlot();
    if (slot === null) return null;
    return props.song.samples[slot - 1]?.name ?? '';
  };

  const effect = () => {
    const c = cell();
    return c ? explainEffect(c.effect, c.effectParam) : null;
  };

  return (
    <div class="patternhelp">
      <div class="patternhelp__row">
        <span class="patternhelp__seg">
          <span class="patternhelp__label">Note</span>
          <span class="patternhelp__value">
            <Show when={noteName()} fallback={<span class="patternhelp__muted">—</span>}>
              {(n) => <>{n()}</>}
            </Show>
          </span>
        </span>
        <span class="patternhelp__seg">
          <span class="patternhelp__label">Sample</span>
          <span class="patternhelp__value">
            <Show
              when={sampleSlot() !== null}
              fallback={<span class="patternhelp__muted">— (no change)</span>}
            >
              {(() => {
                const slot = sampleSlot()!;
                const name = sampleName();
                return (
                  <>
                    {slot.toString(16).toUpperCase().padStart(2, '0')}
                    <Show when={name}>
                      <span class="patternhelp__sub"> · {name}</span>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </span>
        </span>
        <span class="patternhelp__seg patternhelp__seg--wide">
          <span class="patternhelp__label">Effect</span>
          <span class="patternhelp__value">
            <Show
              when={effect()}
              fallback={
                <>
                  <span class="patternhelp__mono">{cell() ? effectCellText(cell()!) : '...'}</span>
                  <span class="patternhelp__muted"> · none</span>
                </>
              }
            >
              {(ex) => (
                <>
                  <span class="patternhelp__mono">{effectCellText(cell()!)}</span>
                  <span class="patternhelp__sub"> · {ex().name}</span>
                  <Show when={ex().param}>
                    {(p) => <span class="patternhelp__sub"> ({p()})</span>}
                  </Show>
                  <Show when={ex().hi !== undefined && ex().lo !== undefined}>
                    {(() => {
                      const c = cell()!;
                      const hi = ((c.effectParam >> 4) & 0xf).toString(16).toUpperCase();
                      const lo = (c.effectParam & 0xf).toString(16).toUpperCase();
                      return (
                        <span class="patternhelp__sub">
                          {' '}({hi} = {ex().hi}, {lo} = {ex().lo})
                        </span>
                      );
                    })()}
                  </Show>
                </>
              )}
            </Show>
          </span>
        </span>
      </div>
    </div>
  );
};
