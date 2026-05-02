import { For, Index, Show, createEffect, createMemo, untrack, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { PERIOD_TABLE } from '../core/mod/format';
import { flattenSong } from '../core/mod/flatten';
import { beatsPerBar, rowsPerBeat } from '../state/gridConfig';
import { cursor, jumpRequest, type Field } from '../state/cursor';

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

interface SampleChars {
  hi: string;
  lo: string;
}

function sampleChars(note: Note): SampleChars {
  if (note.sample === 0) return { hi: '.', lo: '.' };
  const hi = ((note.sample >> 4) & 0xf).toString(16).toUpperCase();
  const lo = (note.sample & 0xf).toString(16).toUpperCase();
  return { hi, lo };
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

  // Center the playhead row when the song is playing. We skip this when
  // stopped because in that mode the playhead tracks the cursor — the
  // margin-based cursor scroller below handles it more gently.
  createEffect(() => {
    if (!props.active) return;
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
    if (props.active) return;
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

  // Discrete "jump" snap: when an explicit navigation action (order-list
  // click, Insert slot) bumps `jumpRequest`, snap the cursor row to the top
  // of the viewport so the user sees the bulk of the destination pattern
  // below. Without this, jumping forward to a new order lands the cursor
  // at the bottom of the viewport (the margin-effect above only nudges the
  // nearer edge into view, which for a downward jump is the bottom).
  //
  // Registered after the margin effect so when both signals tick in the
  // same batch, this runs last and wins the final scrollTop assignment.
  // Reads `cursorFlatIndex` and `props.active` via untrack — the trigger
  // here is purely the jump counter, not cursor / playback changes.
  let firstJump = true;
  createEffect(() => {
    jumpRequest();
    if (firstJump) { firstJump = false; return; }
    if (untrack(() => props.active)) return;
    const idx = untrack(cursorFlatIndex);
    if (idx < 0 || !scroller) return;
    const child = scroller.children[idx] as HTMLElement | undefined;
    if (!child) return;
    scroller.scrollTop = child.offsetTop;
  });

  /** True if the cursor is on (this row, this channel, this field). Hidden during playback. */
  const isCursorAt = (rowIdx: number, channel: number, field: Field): boolean => {
    if (props.active) return false;
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
          {/* <Index> keeps row DOM mounted at each position; only the reactive
              expressions inside re-evaluate when the row's data changes. This
              makes column-shifting edits (Backspace / Enter, which rewrite
              every Note[] from the cursor downward) O(changed cells) instead
              of O(remounted rows) — the inner <For> over cells then preserves
              the 3 unchanged channel cells per row by Note reference. */}
          <Index each={flat()}>
            {(item, i) => {
              const rowIndex = createMemo(() => item().rowIndex);
              const beat = createMemo(() => rowsPerBeat());
              const bar = createMemo(() => beat() * beatsPerBar());
              const isBeat = createMemo(() => beat() > 0 && rowIndex() % beat() === 0);
              const isBar = createMemo(() => bar() > 0 && rowIndex() % bar() === 0);
              return (
                <div
                  class="patgrid__row"
                  classList={{
                    'patgrid__row--beat': isBeat() && !isBar(),
                    'patgrid__row--bar': isBar(),
                    'patgrid__row--boundary': item().boundaryAbove,
                    'patgrid__row--active': props.active && i === activeFlatIndex(),
                    'patgrid__row--cursor': !props.active && i === activeFlatIndex(),
                  }}
                >
                  <span class="patgrid__num">
                    {rowIndex().toString(16).toUpperCase().padStart(2, '0')}
                  </span>
                  <For each={item().cells}>
                    {(note, ch) => {
                      const eff = createMemo(() => effectChars(note));
                      const samp = createMemo(() => sampleChars(note));
                      const blank = createMemo(() => note.effect === 0 && note.effectParam === 0);
                      return (
                        <span class="patgrid__cell">
                          <span
                            class="patgrid__note"
                            classList={{
                              'patgrid__part--empty': note.period === 0,
                              'patgrid__field--cursor': isCursorAt(i, ch(), 'note'),
                            }}
                          >
                            {periodToNoteName(note.period)}
                          </span>
                          <span class="patgrid__samp">
                            <span
                              class="patgrid__samp-char"
                              classList={{
                                'patgrid__part--empty': note.sample === 0,
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'sampleHi'),
                              }}
                            >
                              {samp().hi}
                            </span>
                            <span
                              class="patgrid__samp-char"
                              classList={{
                                'patgrid__part--empty': note.sample === 0,
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'sampleLo'),
                              }}
                            >
                              {samp().lo}
                            </span>
                          </span>
                          <span class="patgrid__eff">
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank(),
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'effectCmd'),
                              }}
                            >
                              {eff().cmd}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank(),
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'effectHi'),
                              }}
                            >
                              {eff().hi}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank(),
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'effectLo'),
                              }}
                            >
                              {eff().lo}
                            </span>
                          </span>
                        </span>
                      );
                    }}
                  </For>
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
};
