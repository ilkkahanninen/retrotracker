import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import {
  decodeVolumeColumn,
  effectChar,
  noteString,
} from "../core/xm/effectLabels";
import { flattenXmSong } from "../core/xm/flatten";
import type { XmNote, XmSong } from "../core/xm/types";
import { beatsPerBar, rowsPerBeat } from "../state/gridConfig";
import { setXmCursor, xmCursor, type XmField } from "../state/cursorXm";
import { selectionContains, xmSelection } from "../state/selection";
import { channelLevels } from "../state/channelLevel";
import {
  mutedChannels,
  soloedChannels,
  toggleMute,
  toggleSolo,
} from "../state/channelMute";
import {
  computeVisibleRange,
  flatIndexOf,
  keepRowInView,
  PATTERN_ROW_HEIGHT,
} from "./patternGridVirtualization";

interface Props {
  song: XmSong;
  /** Currently-playing position. Highlighted as the playhead while `active`. */
  pos: { order: number; row: number };
  /**
   * `true` while the transport is playing. Mirrors PT2's grid contract:
   * the highlighted row is styled as the playhead (`--active`) while
   * playing, and as the edit cursor (`--cursor`) otherwise. Without this
   * gate the playhead style hides the cursor when the song isn't moving.
   */
  active: boolean;
}

/**
 * FT2 pattern grid. Walks the entire song into one flat row list (mirroring
 * MOD's flatten) so the user can scroll continuously through every order.
 * Pattern boundaries render as a dashed line, exactly like the PT grid.
 *
 * Reuses the PT grid's `.patgrid*` CSS classes so the look & feel matches:
 * the only XM-specific bit is an additional volume-column cell per channel.
 *
 * Click any sub-field to position the FT2 cursor. Keyboard editing,
 * selection drag, and channel mute/VU come in Phase 3-4.
 */
export const PatternGridXm: Component<Props> = (props) => {
  const flat = createMemo(() => flattenXmSong(props.song));

  /** Index of the cursor row inside the flat list, or -1 if hidden. */
  const cursorFlatIndex = createMemo(() => {
    const c = xmCursor();
    return flatIndexOf(
      flat(),
      (fr) => fr.order === c.order && fr.rowIndex === c.row,
    );
  });

  /** Index of the playhead row inside the flat list, or -1 if hidden. */
  const activeFlatIndex = createMemo(() => {
    const { order, row } = props.pos;
    return flatIndexOf(
      flat(),
      (fr) => fr.order === order && fr.rowIndex === row,
    );
  });

  // ── Virtualization ─────────────────────────────────────────────────────
  // Mirrors PT PatternGrid: only the rows in (or near) the viewport mount;
  // the rest are absolute-positioned inside a tall placeholder. Row math
  // lives in `patternGridVirtualization.ts` — shared with PatternGrid.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  let scroller: HTMLDivElement | undefined;

  const visibleRange = createMemo(() =>
    computeVisibleRange(scrollTop(), viewportHeight(), flat().length),
  );

  const visibleRows = createMemo(() => {
    const { start, end } = visibleRange();
    return flat().slice(start, end);
  });

  const onScroll = (e: Event) => {
    setScrollTop((e.currentTarget as HTMLElement).scrollTop);
  };

  onMount(() => {
    if (!scroller) return;
    setViewportHeight(scroller.clientHeight);
    const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : null;
    if (!RO) return;
    const ro = new RO((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportHeight(entry.contentRect.height);
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  // Keep the cursor in view as it moves (e.g. when an order-list click sets
  // cursor.order to a different slot).
  createEffect(() => {
    const idx = cursorFlatIndex();
    if (idx < 0 || !scroller) return;
    keepRowInView(scroller, idx);
  });

  /** True if the cursor sits on (this flat-row index, this channel, this field). */
  const isCursorAt = (
    flatIdx: number,
    channel: number,
    field: XmField,
  ): boolean => {
    if (flatIdx !== cursorFlatIndex()) return false;
    const c = xmCursor();
    return c.channel === channel && c.field === field;
  };

  const focusField = (
    order: number,
    row: number,
    channel: number,
    field: XmField,
  ): void => {
    setXmCursor({ order, row, channel, field });
  };

  /** True if (order, row, channel) lies inside the active selection. */
  const isSelectedAt = (
    order: number,
    row: number,
    channel: number,
  ): boolean => {
    const sel = xmSelection();
    if (!sel || sel.order !== order) return false;
    return selectionContains(sel, row, channel);
  };

  const channelHeader = (ch: number) => (ch + 1).toString().padStart(2, "0");

  /**
   * Natural grid width = row-label column + N channel columns at their
   * minimum size. Set explicitly on the header, the rows scroll-host,
   * and the rows-spacer so .patgrid__rows-spacer doesn't collapse to the
   * viewport (its only children are absolutely positioned and don't
   * contribute to intrinsic size). When the viewport is wider than this,
   * the grid template's `1fr` lets each channel grow to fill — but the
   * minimum keeps the cell content readable.
   */
  const gridWidthPx = createMemo(
    () => ROW_LABEL_PX + props.song.channelCount * CHANNEL_MIN_PX,
  );
  const gridWidthStyle = createMemo(() => `${gridWidthPx()}px`);

  return (
    <div class="patgrid patgrid--xm">
      {/* Horizontal-scroll wrapper holds both header and rows so they scroll
       *  left/right together. The header sits sticky on top within this
       *  wrapper. Vertical scroll lives on .patgrid__rows underneath. */}
      <div class="patgrid__hscroll">
        <div
          class="patgrid__header"
          style={{
            "grid-template-columns": gridTemplateColumns(
              props.song.channelCount,
            ),
            "min-width": gridWidthStyle(),
          }}
        >
          <span class="patgrid__num">Row</span>
          <For
            each={Array.from({ length: props.song.channelCount }, (_, i) => i)}
          >
            {(c) => (
              <span class="patgrid__cell patgrid__chhead">
                <span class="patgrid__chnum">Ch {channelHeader(c)}</span>
                <span class="patgrid__vu" aria-hidden="true">
                  <span
                    class="patgrid__vu-fill"
                    style={{
                      width: `${Math.min(100, (channelLevels()[c] ?? 0) * 100)}%`,
                    }}
                  />
                </span>
                <button
                  type="button"
                  tabindex={-1}
                  class="patgrid__chbtn"
                  classList={{
                    "patgrid__chbtn--active": mutedChannels()[c] === true,
                  }}
                  onClick={() => toggleMute(c)}
                  title={`Mute channel ${c + 1}`}
                >
                  M
                </button>
                <button
                  type="button"
                  tabindex={-1}
                  class="patgrid__chbtn"
                  classList={{
                    "patgrid__chbtn--active": soloedChannels()[c] === true,
                  }}
                  onClick={() => toggleSolo(c)}
                  title={`Solo channel ${c + 1}`}
                >
                  S
                </button>
              </span>
            )}
          </For>
        </div>
        <Show
          when={flat().length > 0}
          fallback={<p class="placeholder">No pattern</p>}
        >
          <div
            class="patgrid__rows"
            ref={(el) => (scroller = el)}
            onScroll={onScroll}
            style={{ "min-width": gridWidthStyle() }}
          >
            <div
              class="patgrid__rows-spacer"
              style={{
                height: `${flat().length * PATTERN_ROW_HEIGHT}px`,
                width: gridWidthStyle(),
              }}
            >
              <For each={visibleRows()}>
                {(item, sliceIdx) => {
                  const flatIdx = createMemo(
                    () => visibleRange().start + sliceIdx(),
                  );
                  const isBeat = createMemo(() => {
                    const b = rowsPerBeat();
                    return b > 0 && item.rowIndex % b === 0;
                  });
                  const isBar = createMemo(() => {
                    const bar = rowsPerBeat() * beatsPerBar();
                    return bar > 0 && item.rowIndex % bar === 0;
                  });
                  return (
                    <div
                      class="patgrid__row"
                      style={{
                        top: `${flatIdx() * PATTERN_ROW_HEIGHT}px`,
                        "grid-template-columns": gridTemplateColumns(
                          props.song.channelCount,
                        ),
                      }}
                      classList={{
                        "patgrid__row--beat": isBeat() && !isBar(),
                        "patgrid__row--bar": isBar(),
                        "patgrid__row--boundary": item.boundaryAbove,
                        "patgrid__row--active":
                          props.active && flatIdx() === activeFlatIndex(),
                        "patgrid__row--cursor":
                          !props.active && flatIdx() === cursorFlatIndex(),
                      }}
                    >
                      <span class="patgrid__num">
                        {item.rowIndex
                          .toString(16)
                          .toUpperCase()
                          .padStart(2, "0")}
                      </span>
                      <For each={item.cells}>
                        {(cell, ch) => (
                          <XmCell
                            cell={cell}
                            flatIdx={flatIdx()}
                            order={item.order}
                            row={item.rowIndex}
                            channel={ch()}
                            isCursorAt={isCursorAt}
                            isSelectedAt={isSelectedAt}
                            focusField={focusField}
                          />
                        )}
                      </For>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

interface CellProps {
  cell: XmNote;
  flatIdx: number;
  order: number;
  row: number;
  channel: number;
  isCursorAt: (flatIdx: number, channel: number, field: XmField) => boolean;
  isSelectedAt: (order: number, row: number, channel: number) => boolean;
  focusField: (
    order: number,
    row: number,
    channel: number,
    field: XmField,
  ) => void;
}

const XmCell: Component<CellProps> = (props) => {
  const noteText = createMemo(() => noteString(props.cell.note));
  const noteEmpty = createMemo(() => props.cell.note === 0);
  const instHi = createMemo(() =>
    props.cell.instrument === 0
      ? "·"
      : ((props.cell.instrument >>> 4) & 0xf).toString(16).toUpperCase(),
  );
  const instLo = createMemo(() =>
    props.cell.instrument === 0
      ? "·"
      : (props.cell.instrument & 0xf).toString(16).toUpperCase(),
  );
  const instEmpty = createMemo(() => props.cell.instrument === 0);
  const vol = createMemo(() => decodeVolumeColumn(props.cell.volumeColumn));
  const volKindChar = createMemo(() => vol()?.kind ?? "·");
  const volMagChar = createMemo(() =>
    vol() ? vol()!.magnitude.toString(16).toUpperCase() : "·",
  );
  const volEmpty = createMemo(() => props.cell.volumeColumn === 0);
  const fxEmpty = createMemo(
    () => props.cell.effect === 0 && props.cell.effectParam === 0,
  );
  const fxCmd = createMemo(() =>
    fxEmpty() ? "·" : effectChar(props.cell.effect),
  );
  const fxHi = createMemo(() =>
    fxEmpty()
      ? "·"
      : ((props.cell.effectParam >>> 4) & 0xf).toString(16).toUpperCase(),
  );
  const fxLo = createMemo(() =>
    fxEmpty() ? "·" : (props.cell.effectParam & 0xf).toString(16).toUpperCase(),
  );

  const focus = (e: MouseEvent, field: XmField) => {
    if (e.button !== 0) return;
    props.focusField(props.order, props.row, props.channel, field);
  };

  return (
    <span
      class="patgrid__cell"
      classList={{
        "patgrid__cell--selected": props.isSelectedAt(
          props.order,
          props.row,
          props.channel,
        ),
      }}
      attr:data-order={props.order}
      attr:data-row={props.row}
      attr:data-channel={props.channel}
      onMouseDown={(e) => focus(e, "note")}
    >
      <span
        class="patgrid__note"
        classList={{
          "patgrid__part--empty": noteEmpty(),
          "patgrid__field--cursor": props.isCursorAt(
            props.flatIdx,
            props.channel,
            "note",
          ),
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          focus(e, "note");
        }}
      >
        {noteText()}
      </span>
      <span class="patgrid__samp">
        <span
          class="patgrid__samp-char"
          classList={{
            "patgrid__part--empty": instEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "instHi",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "instHi");
          }}
        >
          {instHi()}
        </span>
        <span
          class="patgrid__samp-char"
          classList={{
            "patgrid__part--empty": instEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "instLo",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "instLo");
          }}
        >
          {instLo()}
        </span>
      </span>
      <span class="patgrid__vol">
        <span
          class="patgrid__vol-char patgrid__vol-char--kind"
          classList={{
            "patgrid__part--empty": volEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "volHi",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "volHi");
          }}
        >
          {volKindChar()}
        </span>
        <span
          class="patgrid__vol-char patgrid__vol-char--mag"
          classList={{
            "patgrid__part--empty": volEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "volLo",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "volLo");
          }}
        >
          {volMagChar()}
        </span>
      </span>
      <span class="patgrid__eff">
        <span
          class="patgrid__eff-char"
          classList={{
            "patgrid__part--empty": fxEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "effectCmd",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "effectCmd");
          }}
        >
          {fxCmd()}
        </span>
        <span
          class="patgrid__eff-char"
          classList={{
            "patgrid__part--empty": fxEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "effectHi",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "effectHi");
          }}
        >
          {fxHi()}
        </span>
        <span
          class="patgrid__eff-char"
          classList={{
            "patgrid__part--empty": fxEmpty(),
            "patgrid__field--cursor": props.isCursorAt(
              props.flatIdx,
              props.channel,
              "effectLo",
            ),
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            focus(e, "effectLo");
          }}
        >
          {fxLo()}
        </span>
      </span>
    </span>
  );
};

/** PT grid uses `36px repeat(CHANNELS, 1fr)`. XM matches that shape but
 *  with N channels and a minimum per-channel width so 16+ channel files
 *  don't collapse cell content into a few unreadable pixels — anything
 *  past the viewport scrolls horizontally via .patgrid__hscroll. */
const ROW_LABEL_PX = 36;
const CHANNEL_MIN_PX = 110;
function gridTemplateColumns(channelCount: number): string {
  return `${ROW_LABEL_PX}px repeat(${channelCount}, minmax(${CHANNEL_MIN_PX}px, 1fr))`;
}
