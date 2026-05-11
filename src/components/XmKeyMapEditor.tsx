import { For, type Component } from "solid-js";

import type { XmInstrument } from "../core/xm/types";
import { setXmKeyMap } from "../state/xmInstrumentEdit";
import { currentXmSampleIndex } from "../state/xmEdit";

interface Props {
  instrument: XmInstrument;
  /** 1-based instrument slot, threaded into the mutation. */
  slot1Based: number;
}

const NOTE_NAMES = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
];

/**
 * 96-cell note → sample-index map editor. 8 octaves (C-0..B-7) by 12
 * pitch classes; click (or drag) any cell to paint the currently
 * selected sample index into it. Cells display the hex index that the
 * note routes to, which lines up with the sample-list chip labels above.
 *
 * Painting is throttled to whole rerenders — keymap edits commit through
 * the existing history machinery, which means each touch creates an
 * undo step. The "drag-paint" handler skips repeats so dragging across
 * an unchanged cell doesn't pile up undo entries.
 */
export const XmKeyMapEditor: Component<Props> = (props) => {
  let lastPainted = -1;

  const paint = (noteIdx: number) => {
    if (noteIdx < 0 || noteIdx >= 96) return;
    if (noteIdx === lastPainted) return;
    const current = props.instrument.keyMap[noteIdx] ?? 0;
    const target = currentXmSampleIndex();
    if (current === target) {
      lastPainted = noteIdx;
      return;
    }
    const next = new Uint8Array(props.instrument.keyMap);
    next[noteIdx] = target;
    setXmKeyMap(props.slot1Based, next);
    lastPainted = noteIdx;
  };

  // Octaves stacked vertically; pitch classes laid out horizontally so
  // the user reads a piano grid (sharps/flats included).
  const octaves = () => Array.from({ length: 8 }, (_, i) => i);

  return (
    <div
      class="xm-keymap"
      onPointerDown={(e) => {
        const noteIdx = noteIndexFromEvent(e);
        if (noteIdx === null) return;
        e.preventDefault();
        lastPainted = -1;
        paint(noteIdx);
        // jsdom doesn't implement setPointerCapture; guard so tests don't crash.
        const el = e.currentTarget as HTMLElement;
        if (typeof el.setPointerCapture === "function") {
          el.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        const noteIdx = noteIndexFromEvent(e);
        if (noteIdx === null) return;
        paint(noteIdx);
      }}
      onPointerUp={() => {
        lastPainted = -1;
      }}
    >
      <For each={octaves()}>
        {(oct) => (
          <div class="xm-keymap__row">
            <span class="xm-keymap__row-label">Oct {oct}</span>
            <For each={NOTE_NAMES}>
              {(name, i) => {
                const noteIdx = oct * 12 + i();
                return (
                  <button
                    type="button"
                    class="xm-keymap__cell"
                    data-keymap-note={noteIdx}
                    title={`${name}${oct} → sample ${(
                      props.instrument.keyMap[noteIdx] ?? 0
                    )
                      .toString(16)
                      .toUpperCase()}`}
                  >
                    {(props.instrument.keyMap[noteIdx] ?? 0)
                      .toString(16)
                      .toUpperCase()}
                  </button>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

/** Walk up from `event.target` to find a cell carrying `data-keymap-note`. */
function noteIndexFromEvent(e: PointerEvent): number | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const cell = target.closest("[data-keymap-note]");
  if (!cell) return null;
  const raw = cell.getAttribute("data-keymap-note");
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
