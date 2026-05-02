import { For, Index, Show, createEffect, createMemo, onCleanup, untrack, type Component } from 'solid-js';
import type { Note, Song } from '../core/mod/types';
import { CHANNELS } from '../core/mod/types';
import { PERIOD_TABLE } from '../core/mod/format';
import { flattenSong } from '../core/mod/flatten';
import { beatsPerBar, rowsPerBeat } from '../state/gridConfig';
import { cursor, setCursor, jumpRequest, type Cursor, type Field } from '../state/cursor';
import { setPlayPos, transport } from '../state/song';
import {
  selection, setSelection, setSelectionAnchor, makeSelection,
  selectionContains,
} from '../state/selection';

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
  /**
   * Called when the user clicks a cell sub-field (note / sample-hi/lo /
   * effect-cmd/hi/lo). The handler decides whether to honour the click —
   * App routes it through `applyCursor`, which suppresses cursor moves
   * during playback. Optional so the standalone PatternGrid tests don't
   * have to wire a no-op.
   */
  onCellClick?: (next: Cursor) => void;
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

  // ── Drag-selection ──────────────────────────────────────────────────────
  // Anchor cell of an in-flight drag (mousedown on a cell, mouseup or leave
  // ends it). When a drag moves into a different cell within the same order
  // we extend the selection rectangle from anchor → current. Cross-order
  // drags are clamped: we only update while the pointer is inside the same
  // order the drag started in. Single-click without movement leaves the
  // selection cleared so the cursor jump alone is the visible effect.
  let dragAnchor: { order: number; row: number; channel: number } | null = null;

  const startDrag = (order: number, row: number, channel: number) => {
    dragAnchor = { order, row, channel };
    // Anchor the selection at the start cell so a follow-up shift-arrow
    // extends from this corner — the selection-anchor signal lives at
    // module scope, App's `extendSelection` reads it. We DON'T paint a 1×1
    // selection rectangle yet — that would highlight on a plain click,
    // which is just confusing; mousemove on a different cell starts the
    // visible selection.
    setSelection(null);
    setSelectionAnchor({ order, row, channel });
  };

  const extendDragTo = (order: number, row: number, channel: number) => {
    if (!dragAnchor) return;
    if (dragAnchor.order !== order) return; // cross-order drag — ignore
    // The cursor follows the drag's active end so shift-arrow after the
    // drag continues to extend from the original anchor. Field is preserved
    // (the drag doesn't change which sub-column the user is editing).
    if (transport() !== 'playing') {
      const c = cursor();
      if (c.row !== row || c.channel !== channel || c.order !== order) {
        setCursor({ ...c, order, row, channel });
        setPlayPos({ order, row });
      }
    }
    if (dragAnchor.row === row && dragAnchor.channel === channel) {
      setSelection(null);
      return;
    }
    setSelection(makeSelection(
      order,
      dragAnchor.row, dragAnchor.channel,
      row, channel,
    ));
  };

  /** Resolve a pointer position to (order, row, channel) via the cell's
   *  data-* attributes. Returns null when the pointer isn't over a cell. */
  const cellAtPoint = (clientX: number, clientY: number): { order: number; row: number; channel: number } | null => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!(el instanceof Element)) return null;
    const cell = el.closest('.patgrid__cell[data-row]') as HTMLElement | null;
    if (!cell) return null;
    const order = parseInt(cell.dataset['order'] ?? '', 10);
    const row = parseInt(cell.dataset['row'] ?? '', 10);
    const channel = parseInt(cell.dataset['channel'] ?? '', 10);
    if (!Number.isFinite(order) || !Number.isFinite(row) || !Number.isFinite(channel)) return null;
    return { order, row, channel };
  };

  // Window-level pointer handlers — installed once. They no-op when there's
  // no in-flight drag, so we can keep them registered without filtering at
  // the React/Solid prop level.
  const onWindowMouseMove = (e: MouseEvent) => {
    if (!dragAnchor) return;
    const target = cellAtPoint(e.clientX, e.clientY);
    if (!target) return;
    extendDragTo(target.order, target.row, target.channel);
  };
  const onWindowMouseUp = () => {
    dragAnchor = null;
  };
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  onCleanup(() => {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
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
                      // mousedown → place the cursor at this cell's sub-field
                      // AND open a drag anchor on this cell. The cell-level
                      // fallback (mousedown on padding around the characters)
                      // lands on `note`, mirroring FT2's "click anywhere on
                      // the cell to focus its note column".
                      const focusAndDrag = (e: MouseEvent, field: Field) => {
                        if (e.button !== 0) return;
                        const it = item();
                        props.onCellClick?.({
                          order: it.order, row: it.rowIndex,
                          channel: ch(), field,
                        });
                        startDrag(it.order, it.rowIndex, ch());
                      };
                      // Selection highlight: ".patgrid__cell--selected" sits
                      // on the cell wrapper so its background paints under
                      // the field characters; the cursor-field underline
                      // remains legible because it has its own colour.
                      const isSelected = createMemo(() => {
                        const sel = selection();
                        if (!sel) return false;
                        if (sel.order !== item().order) return false;
                        return selectionContains(sel, item().rowIndex, ch());
                      });
                      return (
                        <span
                          class="patgrid__cell"
                          classList={{ 'patgrid__cell--selected': isSelected() }}
                          attr:data-order={item().order}
                          attr:data-row={item().rowIndex}
                          attr:data-channel={ch()}
                          onMouseDown={(e) => focusAndDrag(e, 'note')}
                        >
                          <span
                            class="patgrid__note"
                            classList={{
                              'patgrid__part--empty': note.period === 0,
                              'patgrid__field--cursor': isCursorAt(i, ch(), 'note'),
                            }}
                            onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'note'); }}
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
                              onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'sampleHi'); }}
                            >
                              {samp().hi}
                            </span>
                            <span
                              class="patgrid__samp-char"
                              classList={{
                                'patgrid__part--empty': note.sample === 0,
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'sampleLo'),
                              }}
                              onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'sampleLo'); }}
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
                              onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'effectCmd'); }}
                            >
                              {eff().cmd}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank(),
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'effectHi'),
                              }}
                              onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'effectHi'); }}
                            >
                              {eff().hi}
                            </span>
                            <span
                              class="patgrid__eff-char"
                              classList={{
                                'patgrid__part--empty': blank(),
                                'patgrid__field--cursor': isCursorAt(i, ch(), 'effectLo'),
                              }}
                              onMouseDown={(e) => { e.stopPropagation(); focusAndDrag(e, 'effectLo'); }}
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
