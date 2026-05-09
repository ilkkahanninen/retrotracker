import { createSignal } from "solid-js";

/**
 * In-memory sample clipboard: a single Int8Array slice copied from the
 * active slot's int8 data. The pattern view has its own clipboard for
 * pattern cells (state/clipboard.ts); this is the parallel one for the
 * sample view, so Cmd+C / Cmd+X / Cmd+V dispatch by `view()`.
 *
 * In-memory only — same policy as the pattern clipboard. There's no
 * useful system-clipboard text representation for raw int8 bytes, and
 * persistence across sessions would surprise users (the pattern
 * clipboard doesn't persist either).
 *
 * Held as a Solid signal so the UI can react to "clipboard has bytes"
 * (the Paste button enables off `sampleClipboard() !== null`). The
 * payload is referentially-immutable: callers always replace the
 * whole array via `setSampleClipboard`.
 */
export const [sampleClipboard, setSampleClipboard] =
  createSignal<Int8Array | null>(null);

/** Sugar for clearing the clipboard — used by the song-load path. */
export function clearSampleClipboard(): void {
  setSampleClipboard(null);
}
