import { For, Show, createEffect, createMemo, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { PERIOD_TABLE } from '../core/mod/format';

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

interface PatternGridProps {
  song: Song;
  pos: { order: number; row: number };
  active: boolean;
}

export const PatternGrid: Component<PatternGridProps> = (props) => {
  const pattern = createMemo(() => {
    const patNum = props.song.orders[props.pos.order] ?? 0;
    return props.song.patterns[patNum] ?? null;
  });

  let scroller: HTMLDivElement | undefined;

  // Scroll the active row into the middle of the viewport whenever it changes.
  // Direct scrollTop math (vs. scrollIntoView) so we don't fight the page.
  createEffect(() => {
    const row = props.pos.row;
    if (!scroller) return;
    const child = scroller.children[row] as HTMLElement | undefined;
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
      <Show when={pattern()} fallback={<p class="placeholder">No pattern</p>}>
        {(p) => (
          <div class="patgrid__rows" ref={(el) => (scroller = el)}>
            <For each={p().rows}>
              {(row, i) => (
                <div
                  class="patgrid__row"
                  classList={{
                    'patgrid__row--beat': i() % 4 === 0,
                    'patgrid__row--active': props.active && i() === props.pos.row,
                    'patgrid__row--cursor': !props.active && i() === props.pos.row,
                  }}
                >
                  <span class="patgrid__num">{i().toString(16).toUpperCase().padStart(2, '0')}</span>
                  <For each={row}>
                    {(note) => (
                      <span class="patgrid__cell">
                        <span class="patgrid__note">{periodToNoteName(note.period)}</span>
                        <span class="patgrid__samp">{sampleStr(note)}</span>
                        <span class="patgrid__eff">{effectStr(note)}</span>
                      </span>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
};
