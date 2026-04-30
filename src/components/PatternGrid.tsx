import { For, Show, createEffect, createMemo, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { PERIOD_TABLE } from '../core/mod/format';
import { flattenSong } from '../core/mod/flatten';
import { beatsPerBar, rowsPerBeat } from '../state/gridConfig';
import { cursor, type Field } from '../state/cursor';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'] as const;

function periodToNoteName(period: number): string {
  if (period === 0) return '---';
  // Mirrors pt2-clone setPeriod's first-greater-or-equal scan in finetune 0,
  // which is the canonical way to map a stored Paula period to a note slot.
  const row = PERIOD_TABLE[0]!;
  for (let i = 0; i < row.length; i++) {
    if (period >= row[i]!) {
      const oct = 1 + Math.floor(i / 12);
      return `${NOTE_NAMES[i % 12]}${oct}`;
    }
  }
  return '???';
}

function sampleStr(note: Note): string {
  return note.sample === 0 ? '..' : note.sample.toString(16).toUpperCase().padStart(2, '0');
}

interface EffectChars {
  cmd: string;
  hi: string;
  lo: string;
}

function effectChars(note: Note): EffectChars {
  if (note.effect === 0 && note.effectParam === 0) return { cmd: '.', hi: '.', lo: '.' };
  const cmd = note.effect.toString(16).toUpperCase();
  const hi = ((note.effectParam >> 4) & 0x0f).toString(16).toUpperCase();
  const lo = (note.effectParam & 0x0f).toString(16).toUpperCase();
  return { cmd, hi, lo };
}

interface PatternGridProps {
  song: Song;
  pos: { order: number; row: number };
  active: boolean;
}

export const PatternGrid: Component<PatternGridProps> = (props) => {
  const flat = createMemo(() => flattenSong(props.song));

  /** Index of the playhead row inside the flat list, or -1 if not visible. */
  const activeFlatIndex = createMemo(() => {
    const items = flat();
    const { order, row } = props.pos;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.order === order && it.rowIndex === row) return i;
    }
    return -1;
  });

  /** Index of the edit cursor row inside the flat list, or -1 if hidden. */
  const cursorFlatIndex = createMemo(() => {
    const items = flat();
    const c = cursor();
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.order === c.order && it.rowIndex === c.row) return i;
    }
    return -1;
  });

  let scroller: HTMLDivElement | undefined;

  // Scroll the playhead row into the middle of the viewport whenever it changes.
  createEffect(() => {
    const idx = activeFlatIndex();
    if (idx < 0 || !scroller) return;
    const child = scroller.children[idx] as HTMLElement | undefined;
    if (!child) return;
    const target = child.offsetTop - scroller.clientHeight / 2 + child.clientHeight / 2;
    scroller.scrollTop = target;
  });

  // Keep the cursor visible as the user navigates with arrows. We pad the
  // viewport edges by a couple of rows so the cursor never sits flush against
  // the top/bottom — once it gets within `margin`, the scroller catches up.
  createEffect(() => {
    const idx = cursorFlatIndex();
    if (idx < 0 || !scroller) return;
    const child = scroller.children[idx] as HTMLElement | undefined;
    if (!child) return;
    const rowH = child.clientHeight;
    const margin = rowH * 2;
    const top = child.offsetTop;
    const bottom = top + rowH;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    if (top - margin < viewTop) {
      scroller.scrollTop = Math.max(0, top - margin);
    } else if (bottom + margin > viewBottom) {
      scroller.scrollTop = bottom + margin - scroller.clientHeight;
    }
  });

  /** True if the cursor is on (this row, this channel, this field). */
  const isCursorAt = (rowIdx: number, channel: number, field: Field): boolean => {
    if (rowIdx !== cursorFlatIndex()) return false;
    const c = cursor();
    return c.channel === channel && c.field === field;
  };

  return (
    <div class="patgrid">
      <div class="patgrid__header">
        <span class="patgrid__num">Row</span>
        <For each={Array.from({ length: CHANNELS }, (_, i) => i)}>
          {(c) => <span class="patgrid__cell">Ch {c + 1}</span>}
        </For>
      </div>
      <Show when={flat().length > 0} fallback={<p class="placeholder">No pattern</p>}>
        <div class="patgrid__rows" ref={(el) => (scroller = el)}>
          <For each={flat()}>
            {(item, i) => {
              const beat = rowsPerBeat();
              const bar = beat * beatsPerBar();
              const isBeat = beat > 0 && item.rowIndex % beat === 0;
              const isBar = bar > 0 && item.rowIndex % bar === 0;
              return (
                <div
                  class="patgrid__row"
                  classList={{
                    'patgrid__row--beat': isBeat && !isBar,
                    'patgrid__row--bar': isBar,
                    'patgrid__row--boundary': item.boundaryAbove,
                    'patgrid__row--active': props.active && i() === activeFlatIndex(),
                    'patgrid__row--cursor': !props.active && i() === activeFlatIndex(),
                  }}
                >
                  <span class="patgrid__num">
                    {item.rowIndex.toString(16).toUpperCase().padStart(2, '0')}
                  </span>
                  <For each={item.cells}>
                    {(note, ch) => {
                      const eff = effectChars(note);
                      const blank = note.effect === 0 && note.effectParam === 0;
                      return (
                        <span class="patgrid__cell">
                          <span
                            class="patgrid__note"
                            classList={{
                              'patgrid__part--empty': note.period === 0,
                              'patgrid__field--cursor': isCursorAt(i(), ch(), 'note'),
                            }}
                          >
                            {periodToNoteName(note.period)}
                          </span>
                          <span
                            class="patgrid__samp"
                            classList={{
                              'patgrid__part--empty': note.sample === 0,
                              'patgrid__field--cursor': isCursorAt(i(), ch(), 'sample'),
                            }}
                          >
                            {sampleStr(note)}
                          </span>
                          <span class="patgrid__eff">
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank,
                                'patgrid__field--cursor': isCursorAt(i(), ch(), 'effectCmd'),
                              }}
                            >
                              {eff.cmd}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank,
                                'patgrid__field--cursor': isCursorAt(i(), ch(), 'effectHi'),
                              }}
                            >
                              {eff.hi}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank,
                                'patgrid__field--cursor': isCursorAt(i(), ch(), 'effectLo'),
                              }}
                            >
                              {eff.lo}
                            </span>
                          </span>
                        </span>
                      );
                    }}
                  </For>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};
