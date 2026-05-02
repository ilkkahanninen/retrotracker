import { createSignal } from 'solid-js';
import type { Note } from '../core/mod/types';

/**
 * In-memory pattern clipboard: a 2-D rectangle of Notes (rows × channels).
 * Held as a Solid signal so the UI can react to "clipboard has content"
 * (e.g. enable/disable a Paste button later). We DON'T put this on the
 * system clipboard — the data is structural (period, sample, effect,
 * effectParam) and there's no useful text representation that round-trips.
 *
 * The slice is referentially-immutable: `setClipboardSlice` always replaces
 * the whole map, so consumers can `===` compare to detect changes.
 */
export interface ClipboardSlice {
  rows: Note[][];
}

export const [clipboardSlice, setClipboardSlice] = createSignal<ClipboardSlice | null>(null);
