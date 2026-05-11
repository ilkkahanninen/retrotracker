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

import { flattenSong } from "../core/mod/flatten";
import type { ModSong } from "../core/mod/types";
import { CHANNELS } from "../core/mod/types";
import { channelLevels } from "../state/channelLevel";
import {
  mutedChannels,
  soloedChannels,
  toggleMute,
  toggleSolo,
} from "../state/channelMute";
import {
  cursor,
  jumpRequest,
  setCursor,
  type Cursor,
  type Field,
} from "../state/cursor";
import { beatsPerBar, rowsPerBeat } from "../state/gridConfig";
import {
  makeSelection,
  selection,
  setSelection,
  setSelectionAnchor,
} from "../state/selection";
import { settings } from "../state/settings";
import { setPlayPos, transport } from "../state/song";

import { makePtFieldOffsets } from "./grid/drawCellPt";
import { drawGridPt } from "./grid/drawGridPt";
import {
  buildGlyphAtlas,
  type GlyphAtlas,
  type GlyphPalette,
} from "./grid/glyphAtlas";
import {
  ROW_HEIGHT,
  ROW_LABEL_W,
  PT_CELL_LAYOUT,
  gridWidth,
  readGridPalette,
  type GridPalette,
} from "./grid/gridGeometry";
import { hitTest } from "./grid/hitTest";
import { useWindowListener } from "./hooks";
import {
  centerRowInView,
  flatIndexOf,
  keepChannelInView,
  keepRowInView,
  snapRowToTop,
} from "./patternGridVirtualization";

interface PatternGridProps {
  song: ModSong;
  pos: { order: number; row: number };
  active: boolean;
  /**
   * Called when the user clicks a cell sub-field. App routes through
   * `applyCursor`, which suppresses cursor moves during playback. Tests
   * pass a no-op to drive the click path without coupling to the App.
   */
  onCellClick?: (next: Cursor) => void;
}

const CHANNEL_HEADER_HEIGHT = 24;

/**
 * PT2 pattern grid, canvas backend. Mirrors PatternGridXmCanvas's
 * structure: DOM scroll container + header, canvas body rendered via
 * the shared glyph atlas. PT2's 4-channel cap means perf was never
 * the issue, but sharing the renderer with FT2 ensures behavioural
 * parity (cursor / selection / playhead look identical) and avoids
 * future drift.
 */
export const PatternGridCanvas: Component<PatternGridProps> = (props) => {
  const flat = createMemo(() => flattenSong(props.song));

  const activeFlatIndex = createMemo(() => {
    const { order, row } = props.pos;
    return flatIndexOf(
      flat(),
      (it) => it.order === order && it.rowIndex === row,
    );
  });

  const cursorFlatIndex = createMemo(() => {
    const c = cursor();
    return flatIndexOf(
      flat(),
      (it) => it.order === c.order && it.rowIndex === c.row,
    );
  });

  const fieldOffsets = makePtFieldOffsets(PT_CELL_LAYOUT);

  // ── Scroll + viewport tracking ────────────────────────────────────────
  let scroller: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [dpr, setDpr] = createSignal(
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  );

  const totalGridWidth = createMemo(() => gridWidth(PT_CELL_LAYOUT, CHANNELS));
  const totalGridHeight = createMemo(() => flat().length * ROW_HEIGHT);

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    setScrollLeft(el.scrollLeft);
    setScrollTop(el.scrollTop);
  };

  // ── Atlas + palette caches ────────────────────────────────────────────
  let atlasCache: GlyphAtlas | null = null;
  let paletteCache: GridPalette | null = null;
  let glyphPaletteCache: GlyphPalette | null = null;

  const getPalette = (): GridPalette => {
    if (!paletteCache && scroller) paletteCache = readGridPalette(scroller);
    return paletteCache!;
  };

  const getAtlas = (): GlyphAtlas => {
    const palette = getPalette();
    const wantPalette: GlyphPalette = {
      fg: palette.fg,
      muted: palette.muted,
      onAccent: palette.onAccent,
    };
    if (
      atlasCache &&
      atlasCache.dpr === dpr() &&
      glyphPaletteCache &&
      glyphPaletteCache.fg === wantPalette.fg &&
      glyphPaletteCache.muted === wantPalette.muted &&
      glyphPaletteCache.onAccent === wantPalette.onAccent
    ) {
      return atlasCache;
    }
    atlasCache = buildGlyphAtlas(dpr(), wantPalette);
    glyphPaletteCache = wantPalette;
    return atlasCache;
  };

  const invalidateAtlas = () => {
    atlasCache = null;
    paletteCache = null;
    glyphPaletteCache = null;
  };

  // ── Drawing ───────────────────────────────────────────────────────────
  let drawScheduled = false;
  const scheduleDraw = () => {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  };

  const draw = () => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const vw = viewportWidth();
    const vh = viewportHeight();
    if (vw === 0 || vh === 0) return;
    const d = dpr();
    const wantW = Math.floor(vw * d);
    const wantH = Math.floor(vh * d);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);

    drawGridPt(ctx, {
      atlas: getAtlas(),
      palette: getPalette(),
      song: props.song,
      flat: flat(),
      layout: PT_CELL_LAYOUT,
      offsets: fieldOffsets,
      scrollLeft: scrollLeft(),
      scrollTop: scrollTop(),
      viewportWidth: vw,
      viewportHeight: vh,
      rowsPerBeat: rowsPerBeat(),
      beatsPerBar: beatsPerBar(),
      channelCount: CHANNELS,
      cursor: props.active ? null : cursor(),
      cursorFlatIndex: cursorFlatIndex(),
      selection: selection(),
      activeFlatIndex: props.active ? activeFlatIndex() : -1,
    });
  };

  createEffect(() => {
    flat();
    scrollLeft();
    scrollTop();
    viewportWidth();
    viewportHeight();
    cursor();
    selection();
    cursorFlatIndex();
    activeFlatIndex();
    rowsPerBeat();
    beatsPerBar();
    props.active;
    dpr();
    settings().colorScheme;
    invalidateAtlas();
    scheduleDraw();
  });

  // ── Mount: ResizeObserver + DPR watcher ───────────────────────────────
  onMount(() => {
    if (!scroller) return;
    setViewportWidth(scroller.clientWidth);
    setViewportHeight(scroller.clientHeight);
    const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : null;
    if (RO) {
      const ro = new RO((entries) => {
        const entry = entries[0];
        if (!entry) return;
        setViewportWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      });
      ro.observe(scroller);
      onCleanup(() => ro.disconnect());
    }
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
    ) {
      const onDprChange = () => setDpr(window.devicePixelRatio || 1);
      const mq = window.matchMedia(`(resolution: ${dpr()}dppx)`);
      mq.addEventListener?.("change", onDprChange);
      onCleanup(() => mq.removeEventListener?.("change", onDprChange));
    }
    // Rebuild the atlas once web fonts settle — the initial build runs
    // with the fallback otherwise.
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.ready.then(() => {
        invalidateAtlas();
        scheduleDraw();
      });
    }
  });

  // ── Scroll-into-view effects ──────────────────────────────────────────
  createEffect(() => {
    if (!props.active) return;
    const idx = activeFlatIndex();
    if (idx < 0 || !scroller) return;
    centerRowInView(scroller, idx);
  });
  createEffect(() => {
    if (props.active) return;
    const idx = cursorFlatIndex();
    if (idx < 0 || !scroller) return;
    keepRowInView(scroller, idx);
  });
  // Horizontal cursor follow — PT2 has 4 channels so this rarely
  // matters in practice, but matching XM avoids surprises if someone
  // is editing in a narrow viewport.
  createEffect(() => {
    if (props.active) return;
    const c = cursor();
    if (!scroller) return;
    keepChannelInView(scroller, c.channel, PT_CELL_LAYOUT.cellW, ROW_LABEL_W);
  });
  // Jump-snap (order-list click, Insert slot): pin the destination row
  // to the viewport top so the user sees the bulk of the next pattern
  // below it. Skips the very first tick (would scroll on mount).
  let firstJump = true;
  createEffect(() => {
    jumpRequest();
    if (firstJump) {
      firstJump = false;
      return;
    }
    if (props.active || !scroller) return;
    const idx = cursorFlatIndex();
    if (idx < 0) return;
    snapRowToTop(scroller, idx);
  });

  // ── Pointer handling ──────────────────────────────────────────────────
  let dragAnchor: {
    flatRowIndex: number;
    channel: number;
    order: number;
    row: number;
  } | null = null;

  const hitTestAt = (clientX: number, clientY: number) => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTest(
      clientX - rect.left,
      clientY - rect.top,
      scrollLeft(),
      scrollTop(),
      PT_CELL_LAYOUT,
      CHANNELS,
      flat().length,
    );
  };

  const onCanvasMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const hit = hitTestAt(e.clientX, e.clientY);
    if (!hit) return;
    const fr = flat()[hit.flatRowIndex];
    if (!fr) return;
    const next: Cursor = {
      order: fr.order,
      row: fr.rowIndex,
      channel: hit.channel,
      field: hit.field as Field,
    };
    // Route through onCellClick so App's applyCursor can suppress
    // cursor moves during playback. Same contract as the DOM grid.
    props.onCellClick?.(next);
    // Start a drag anchor regardless — drag-selection still works during
    // playback in the DOM grid (selection rectangle paints but cursor
    // doesn't move), so we mirror that.
    dragAnchor = {
      flatRowIndex: hit.flatRowIndex,
      channel: hit.channel,
      order: fr.order,
      row: fr.rowIndex,
    };
    setSelection(null);
    setSelectionAnchor({
      order: fr.order,
      row: fr.rowIndex,
      channel: hit.channel,
    });
  };

  const onWindowMouseMove = (e: MouseEvent) => {
    if (!dragAnchor) return;
    const hit = hitTestAt(e.clientX, e.clientY);
    if (!hit) return;
    const fr = flat()[hit.flatRowIndex];
    if (!fr) return;
    if (fr.order !== dragAnchor.order) return;
    if (hit.channel === dragAnchor.channel && fr.rowIndex === dragAnchor.row) {
      setSelection(null);
      return;
    }
    if (transport() !== "playing") {
      const c = cursor();
      if (
        c.order !== fr.order ||
        c.row !== fr.rowIndex ||
        c.channel !== hit.channel
      ) {
        setCursor({
          order: fr.order,
          row: fr.rowIndex,
          channel: hit.channel,
          field: c.field,
        });
        setPlayPos({ order: fr.order, row: fr.rowIndex });
      }
    }
    setSelection(
      makeSelection(
        fr.order,
        dragAnchor.row,
        dragAnchor.channel,
        fr.rowIndex,
        hit.channel,
      ),
    );
  };
  const onWindowMouseUp = () => {
    dragAnchor = null;
  };
  useWindowListener("mousemove", onWindowMouseMove);
  useWindowListener("mouseup", onWindowMouseUp);

  return (
    <div class="patgrid patgrid--canvas">
      <div
        class="patgrid__header"
        style={{ height: `${CHANNEL_HEADER_HEIGHT}px` }}
      >
        <div
          class="patgrid__header-inner"
          style={{
            "grid-template-columns": `${ROW_LABEL_W}px repeat(${CHANNELS}, ${PT_CELL_LAYOUT.cellW}px)`,
            width: `${totalGridWidth()}px`,
            transform: `translateX(${-scrollLeft()}px)`,
          }}
        >
          <span class="patgrid__num">Row</span>
          <For each={Array.from({ length: CHANNELS }, (_, i) => i)}>
            {(c) => (
              <span class="patgrid__cell patgrid__chhead">
                <span class="patgrid__chnum">
                  {(c + 1).toString().padStart(2, "0")}
                </span>
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
                  title={`Mute channel ${c + 1} (Alt+${c + 1})`}
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
                  title={`Solo channel ${c + 1} (Alt+Shift+${c + 1})`}
                >
                  S
                </button>
              </span>
            )}
          </For>
        </div>
      </div>
      <Show
        when={flat().length > 0}
        fallback={<p class="placeholder">No pattern</p>}
      >
        <div
          class="patgrid__rows"
          ref={(el) => (scroller = el)}
          onScroll={onScroll}
        >
          <div
            class="patgrid__rows-spacer"
            style={{
              width: `${totalGridWidth()}px`,
              height: `${totalGridHeight()}px`,
            }}
          />
          <canvas
            ref={(el) => (canvas = el)}
            class="patgrid__canvas"
            style={{
              position: "absolute",
              top: "0",
              left: "0",
              width: `${viewportWidth()}px`,
              height: `${viewportHeight()}px`,
              transform: `translate(${scrollLeft()}px, ${scrollTop()}px)`,
              "will-change": "transform",
              "pointer-events": "auto",
            }}
            onMouseDown={onCanvasMouseDown}
          />
        </div>
      </Show>
    </div>
  );
};
