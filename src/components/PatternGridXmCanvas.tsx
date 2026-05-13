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

import { flattenXmSong } from "../core/xm/flatten";
import type { XmSong } from "../core/xm/types";
import { channelLevels } from "../state/channelLevel";
import {
  mutedChannels,
  soloedChannels,
  toggleMute,
  toggleSolo,
} from "../state/channelMute";
import { setXmCursor, xmCursor, type XmField } from "../state/cursorXm";
import { beatsPerBar, rowsPerBeat } from "../state/gridConfig";
import { settings } from "../state/settings";
import { setPlayPos, transport } from "../state/song";
import {
  setXmSelection,
  setXmSelectionAnchor,
  xmSelection,
  makeSelection,
} from "../state/selection";

import { makeXmFieldOffsets } from "./grid/drawCellXm";
import { drawGridXm } from "./grid/drawGridXm";
import {
  buildGlyphAtlas,
  type GlyphAtlas,
  type GlyphPalette,
} from "./grid/glyphAtlas";
import {
  ROW_HEIGHT,
  ROW_LABEL_W,
  XM_CELL_LAYOUT,
  effectiveCellW,
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
} from "./patternGridVirtualization";

interface Props {
  song: XmSong;
  /** Currently-playing position. Highlighted as the playhead while `active`. */
  pos: { order: number; row: number };
  /**
   * `true` while the transport is playing. The playhead row tints
   * `--accent`; cursor highlighting hides.
   */
  active: boolean;
}

const CHANNEL_HEADER_HEIGHT = 24; // matches the DOM grid's header row height.

/**
 * FT2 pattern grid, canvas backend. The DOM cost of the previous
 * implementation (~23k nodes at 32 channels) dominated paint time on
 * low-end laptops; this version renders the whole pattern body into a
 * single canvas via a pre-rasterised glyph atlas. The header (M/S +
 * VU + channel labels) stays in DOM because the controls are cheap
 * and easier to expose to keyboard / screen readers.
 *
 * Click → cursor delegated through a pointermove/up window listener
 * pair so drag-selection works even when the pointer leaves the
 * canvas. The cell coords come from `hitTest` math; no DOM lookup.
 */
export const PatternGridXmCanvas: Component<Props> = (props) => {
  const flat = createMemo(() => flattenXmSong(props.song));

  const cursorFlatIndex = createMemo(() => {
    const c = xmCursor();
    return flatIndexOf(
      flat(),
      (fr) => fr.order === c.order && fr.rowIndex === c.row,
    );
  });

  const activeFlatIndex = createMemo(() => {
    const { order, row } = props.pos;
    return flatIndexOf(
      flat(),
      (fr) => fr.order === order && fr.rowIndex === row,
    );
  });

  const fieldOffsets = makeXmFieldOffsets(XM_CELL_LAYOUT);

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

  // Stretch cells to fill horizontal slack: narrow patterns (few
  // channels in a wide viewport) get wider cells with centred text;
  // wide patterns keep the natural cellW and scroll horizontally.
  const cellW = createMemo(() =>
    effectiveCellW(
      XM_CELL_LAYOUT.cellW,
      props.song.channelCount,
      viewportWidth(),
    ),
  );
  const totalGridWidth = createMemo(() =>
    gridWidth(props.song.channelCount, cellW()),
  );
  const totalGridHeight = createMemo(() => flat().length * ROW_HEIGHT);

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    setScrollLeft(el.scrollLeft);
    setScrollTop(el.scrollTop);
  };

  // ── Atlas + palette caches ────────────────────────────────────────────
  // Rebuilt when DPR or the theme changes.
  let atlasCache: GlyphAtlas | null = null;
  let paletteCache: GridPalette | null = null;
  let glyphPaletteCache: GlyphPalette | null = null;

  const getPalette = (): GridPalette => {
    if (!paletteCache && scroller) {
      paletteCache = readGridPalette(scroller);
    }
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

  /** Force atlas + palette rebuild — used when the user switches
   *  colour schemes. */
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
    // Size canvas to viewport × DPR. Avoid resizing unnecessarily.
    const d = dpr();
    const wantW = Math.floor(vw * d);
    const wantH = Math.floor(vh * d);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);

    drawGridXm(ctx, {
      atlas: getAtlas(),
      palette: getPalette(),
      song: props.song,
      flat: flat(),
      layout: XM_CELL_LAYOUT,
      offsets: fieldOffsets,
      cellW: cellW(),
      scrollLeft: scrollLeft(),
      scrollTop: scrollTop(),
      viewportWidth: vw,
      viewportHeight: vh,
      rowsPerBeat: rowsPerBeat(),
      beatsPerBar: beatsPerBar(),
      cursor: props.active ? null : xmCursor(),
      cursorFlatIndex: cursorFlatIndex(),
      selection: xmSelection(),
      activeFlatIndex: props.active ? activeFlatIndex() : -1,
    });
  };

  // Schedule a redraw whenever any reactive input changes.
  createEffect(() => {
    // Touch every reactive dep so Solid registers them.
    flat();
    scrollLeft();
    scrollTop();
    viewportWidth();
    viewportHeight();
    xmCursor();
    xmSelection();
    cursorFlatIndex();
    activeFlatIndex();
    rowsPerBeat();
    beatsPerBar();
    props.active;
    dpr();
    // Theme switch invalidates the atlas; touch the signal so we re-fire.
    settings().colorScheme;
    invalidateAtlas();
    scheduleDraw();
  });

  // ── Mount: ResizeObserver + initial measurements ──────────────────────
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
    // Respond to zoom (DPR changes). jsdom lacks matchMedia, so we
    // guard — DPR changes during tests aren't a thing anyway.
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
    ) {
      const onDprChange = () => setDpr(window.devicePixelRatio || 1);
      const mq = window.matchMedia(`(resolution: ${dpr()}dppx)`);
      mq.addEventListener?.("change", onDprChange);
      onCleanup(() => mq.removeEventListener?.("change", onDprChange));
    }
    // When the web font finalises after first draw, the initial atlas
    // was built with the fallback. Rebuild + redraw once fonts settle.
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
  // Keyboard moves can carry the cursor past the visible channel range
  // on many-channel XMs. Skipped during playback for the same reason
  // the row-keep effect is — the playhead owns scroll then.
  createEffect(() => {
    if (props.active) return;
    const c = xmCursor();
    if (!scroller) return;
    keepChannelInView(scroller, c.channel, cellW(), ROW_LABEL_W);
  });

  // ── Pointer handling ─────────────────────────────────────────────────
  // Drag-selection state. Set on mousedown inside the canvas; cleared
  // on mouseup anywhere.
  let dragAnchor: {
    flatRowIndex: number;
    channel: number;
    order: number;
    row: number;
  } | null = null;

  /** Resolve a viewport-relative pointer position to a grid cell. */
  const hitTestAt = (clientX: number, clientY: number) => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTest(
      clientX - rect.left,
      clientY - rect.top,
      scrollLeft(),
      scrollTop(),
      XM_CELL_LAYOUT,
      props.song.channelCount,
      flat().length,
      cellW(),
    );
  };

  const onCanvasMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (transport() === "playing") return;
    const hit = hitTestAt(e.clientX, e.clientY);
    if (!hit) return;
    const fr = flat()[hit.flatRowIndex];
    if (!fr) return;
    setXmCursor({
      order: fr.order,
      row: fr.rowIndex,
      channel: hit.channel,
      field: hit.field as XmField,
    });
    setPlayPos({ order: fr.order, row: fr.rowIndex });
    // Anchor a potential drag selection (selection rectangle only
    // appears once the pointer moves to a different cell).
    dragAnchor = {
      flatRowIndex: hit.flatRowIndex,
      channel: hit.channel,
      order: fr.order,
      row: fr.rowIndex,
    };
    setXmSelection(null);
    setXmSelectionAnchor({
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
    if (fr.order !== dragAnchor.order) return; // cross-order drags ignored.
    if (hit.channel === dragAnchor.channel && fr.rowIndex === dragAnchor.row) {
      // Same cell — clear the selection rectangle so a no-op drag
      // doesn't leave a 1×1 highlight.
      setXmSelection(null);
      return;
    }
    // Move the cursor's active end along with the drag.
    if (transport() !== "playing") {
      const c = xmCursor();
      if (
        c.order !== fr.order ||
        c.row !== fr.rowIndex ||
        c.channel !== hit.channel
      ) {
        setXmCursor({
          order: fr.order,
          row: fr.rowIndex,
          channel: hit.channel,
          field: c.field,
        });
        setPlayPos({ order: fr.order, row: fr.rowIndex });
      }
    }
    setXmSelection(
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

  // Channel header is DOM. Compact "01" labels (Ch prefix dropped) so
  // the VU bar gets more space.
  const channelHeaderText = (ch: number) =>
    (ch + 1).toString().padStart(2, "0");

  return (
    <div class="patgrid patgrid--xm patgrid--canvas">
      <div
        class="patgrid__header"
        style={{ height: `${CHANNEL_HEADER_HEIGHT}px` }}
      >
        <div
          class="patgrid__header-inner"
          style={{
            "grid-template-columns": `${ROW_LABEL_W}px repeat(${props.song.channelCount}, ${cellW()}px)`,
            width: `${totalGridWidth()}px`,
            transform: `translateX(${-scrollLeft()}px)`,
          }}
        >
          <span class="patgrid__num">Row</span>
          <For
            each={Array.from({ length: props.song.channelCount }, (_, i) => i)}
          >
            {(c) => (
              <span class="patgrid__cell patgrid__chhead">
                <span class="patgrid__chnum">{channelHeaderText(c)}</span>
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
              // GPU compositor handles transform without triggering
              // layout, which keeps the canvas pinned to the viewport
              // smoothly during trackpad scroll.
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
