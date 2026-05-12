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
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

/**
 * 96-cell note → sample-index map editor. 8 octaves (C-0..B-7) by 12
 * pitch classes; click (or drag) any cell to paint the currently
 * selected sample index into it. Cells display the hex index that the
 * note routes to, which lines up with the sample-list chip labels above.
 *
 * Painting uses `document.elementFromPoint` during drag so the cells
 * the pointer passes through fire even after `setPointerCapture` has
 * redirected `e.target` to the container.
 *
 * The "Oct N" row label is itself a button: clicking it stamps the
 * current sample across all 12 notes of that octave in one mutation
 * (one undo step).
 */
export const XmKeyMapEditor: Component<Props> = (props) => {
  let lastPainted = -1;

  const paintAt = (noteIdx: number) => {
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

  const cellNote = (el: Element | null): number | null => {
    if (!el) return null;
    const cell = el.closest("[data-keymap-note]");
    if (!cell) return null;
    const raw = cell.getAttribute("data-keymap-note");
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  /** Resolve the keymap cell under the pointer, even when pointer
   *  capture has redirected `event.target` to the container. Falls
   *  back to `e.target` when `elementFromPoint` isn't available
   *  (jsdom in tests). */
  const noteIndexAt = (e: PointerEvent): number | null => {
    if (typeof document.elementFromPoint === "function") {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const idx = cellNote(el instanceof Element ? el : null);
      if (idx !== null) return idx;
    }
    return cellNote(e.target instanceof Element ? e.target : null);
  };

  /** Stamp the current sample across all 12 notes of an octave in a
   *  single mutation (one undo entry). No-op when the octave already
   *  matches end-to-end. */
  const fillOctave = (oct: number) => {
    const target = currentXmSampleIndex();
    const start = oct * 12;
    const next = new Uint8Array(props.instrument.keyMap);
    let changed = false;
    for (let i = 0; i < 12; i++) {
      if (next[start + i] !== target) {
        next[start + i] = target;
        changed = true;
      }
    }
    if (changed) setXmKeyMap(props.slot1Based, next);
  };

  // Octaves stacked vertically; pitch classes laid out horizontally so
  // the user reads a piano grid (sharps/flats included).
  const octaves = () => Array.from({ length: 8 }, (_, i) => i);

  return (
    <div class="xm-keymap-wrap">
      <div
        class="xm-keymap"
        onPointerDown={(e) => {
          const noteIdx = noteIndexAt(e);
          if (noteIdx === null) return;
          e.preventDefault();
          lastPainted = -1;
          paintAt(noteIdx);
          // jsdom doesn't implement setPointerCapture; guard so tests don't crash.
          const el = e.currentTarget as HTMLElement;
          if (typeof el.setPointerCapture === "function") {
            el.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          const noteIdx = noteIndexAt(e);
          if (noteIdx === null) return;
          paintAt(noteIdx);
        }}
        onPointerUp={() => {
          lastPainted = -1;
        }}
      >
        <div class="xm-keymap__header">
          <span class="xm-keymap__row-label" aria-hidden="true" />
          <For each={NOTE_NAMES}>
            {(name) => (
              <span
                class="xm-keymap__col-label"
                classList={{
                  "xm-keymap__col-label--sharp": name.length > 1,
                }}
              >
                {name}
              </span>
            )}
          </For>
        </div>
        <For each={octaves()}>
          {(oct) => (
            <div class="xm-keymap__row">
              <button
                type="button"
                class="xm-keymap__row-label xm-keymap__row-label--clickable"
                onClick={() => fillOctave(oct)}
                title={`Fill octave ${oct} with the current sample`}
              >
                Oct {oct}
              </button>
              <For each={NOTE_NAMES}>
                {(name, i) => {
                  const noteIdx = oct * 12 + i();
                  return (
                    <button
                      type="button"
                      class="xm-keymap__cell"
                      data-keymap-note={noteIdx}
                      title={`${name}-${oct} → sample ${(
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
      <p class="xm-keymap__help">
        Click or drag to paint the active sample (hex index from the chip strip)
        over notes. Click an <strong>Oct N</strong> label to fill the whole row.
      </p>
    </div>
  );
};
