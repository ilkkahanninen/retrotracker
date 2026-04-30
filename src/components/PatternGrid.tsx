import { For, Show, createEffect, createMemo, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { Effect, PERIOD_TABLE } from '../core/mod/format';
import { beatsPerBar, rowsPerBeat } from '../state/gridConfig';

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

function effectStr(note: Note): string {
  if (note.effect === 0 && note.effectParam === 0) return '...';
  const cmd = note.effect.toString(16).toUpperCase();
  const param = note.effectParam.toString(16).toUpperCase().padStart(2, '0');
  return `${cmd}${param}`;
}

interface FlatRow {
  order: number;
  /** Pattern-relative row index (used for beat/bar markers and the row label). */
  rowIndex: number;
  cells: Note[];
  /** Render a dashed divider above this row (true on the first row of a new pattern segment). */
  boundaryAbove: boolean;
}

/**
 * Walk the order list and produce a single flat row list. Dxx (Pattern Break)
 * truncates the rest of the current pattern; the next order resumes at the
 * Dxx-target row. Bxx and pattern-loop are deliberately not honored here —
 * they would create infinite views for songs that loop.
 */
function flattenSong(song: Song): FlatRow[] {
  const out: FlatRow[] = [];
  let nextStartRow = 0;
  for (let o = 0; o < song.songLength; o++) {
    const pat = song.patterns[song.orders[o] ?? 0];
    if (!pat) continue;
    const startRow = Math.min(nextStartRow, pat.rows.length - 1);
    nextStartRow = 0;
    for (let r = startRow; r < pat.rows.length; r++) {
      const cells = pat.rows[r]!;
      out.push({
        order: o,
        rowIndex: r,
        cells,
        boundaryAbove: r === startRow && o > 0,
      });
      // PT spec: last Dxx in row order wins for the target row.
      let dxx = -1;
      for (const c of cells) {
        if (c.effect === Effect.PatternBreak) dxx = c.effectParam;
      }
      if (dxx >= 0) {
        nextStartRow = Math.min(((dxx >> 4) * 10) + (dxx & 0x0f), pat.rows.length - 1);
        break;
      }
    }
  }
  return out;
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
                    {(note) => (
                      <span class="patgrid__cell">
                        <span
                          class="patgrid__note"
                          classList={{ 'patgrid__part--empty': note.period === 0 }}
                        >
                          {periodToNoteName(note.period)}
                        </span>
                        <span
                          class="patgrid__samp"
                          classList={{ 'patgrid__part--empty': note.sample === 0 }}
                        >
                          {sampleStr(note)}
                        </span>
                        <span
                          class="patgrid__eff"
                          classList={{
                            'patgrid__part--empty': note.effect === 0 && note.effectParam === 0,
                          }}
                        >
                          {effectStr(note)}
                        </span>
                      </span>
                    )}
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
