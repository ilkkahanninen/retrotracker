import { createSignal } from "solid-js";
import type { Note } from "../core/mod/types";
import type { XmNote } from "../core/xm/types";

/**
 * In-memory pattern clipboard: a 2-D rectangle of Notes (rows × channels).
 * Held as a Solid signal so the UI can react to "clipboard has content"
 * (e.g. enable/disable a Paste button later). We DON'T put this on the
 * system clipboard — the data is structural (period, sample, effect,
 * effectParam) and there's no useful text representation that round-trips.
 *
 * The slice is referentially-immutable: `setClipboardSlice` always replaces
 * the whole map, so consumers can `===` compare to detect changes.
 *
 * PT and FT2 keep separate signals so a PT copy can't pollute an FT2
 * clipboard (and vice versa). Since format is locked per session only one
 * is ever live in practice, but the per-format typing keeps Note and
 * XmNote from being conflated in handlers.
 */
export interface ClipboardSlice {
  rows: Note[][];
}

export interface XmClipboardSlice {
  rows: XmNote[][];
}

export const [clipboardSlice, setClipboardSlice] =
  createSignal<ClipboardSlice | null>(null);

export const [xmClipboardSlice, setXmClipboardSlice] =
  createSignal<XmClipboardSlice | null>(null);
