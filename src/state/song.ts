import { createSignal } from 'solid-js';
import type { Song } from '../core/mod/types';

/**
 * Loaded song. Held as a signal so the UI reactively re-renders on swap;
 * the Song itself is not deeply reactive — pattern editing will go through
 * a dedicated store later when we wire up editing.
 */
export const [song, setSong] = createSignal<Song | null>(null);

export type Transport = 'idle' | 'ready' | 'playing';
export const [transport, setTransport] = createSignal<Transport>('idle');

/** Last (order, row) reported by the worklet — drives the pattern grid cursor. */
export const [playPos, setPlayPos] = createSignal<{ order: number; row: number }>({ order: 0, row: 0 });

/**
 * Edit history.
 *
 * Snapshot-based: each `commitEdit` pushes the pre-edit Song reference onto
 * the past stack and replaces the signal with the new one. Edits should be
 * immutable updates (return a new Song) so that the snapshot we keep stays
 * a stable reference to the prior state.
 *
 * History is capped to keep memory bounded; older entries fall off the bottom.
 * Loading a different file calls `clearHistory` so undo doesn't reach across
 * file boundaries.
 */
export const HISTORY_LIMIT = 200;

const [past, setPast] = createSignal<Song[]>([]);
const [future, setFuture] = createSignal<Song[]>([]);

/** True if there's a prior snapshot the user can revert to. */
export const canUndo = () => past().length > 0;
/** True if there's a redo snapshot waiting. */
export const canRedo = () => future().length > 0;

/**
 * Apply an immutable transform to the current song. Pushes the previous
 * state onto the undo stack, clears redo, and updates the signal.
 *
 * No-op if no song is loaded, the transform returns the same reference, or
 * the transport is currently playing — edits during playback would diverge
 * the on-screen state from what the worklet is rendering.
 */
export function commitEdit(transform: (song: Song) => Song): void {
  if (transport() === 'playing') return;
  const current = song();
  if (!current) return;
  const next = transform(current);
  if (next === current) return;

  const prev = past();
  const trimmed = prev.length >= HISTORY_LIMIT
    ? prev.slice(prev.length - HISTORY_LIMIT + 1)
    : prev;
  setPast([...trimmed, current]);
  setFuture([]);
  setSong(next);
}

/** Pop the latest entry off the undo stack and restore it. No-op while playing. */
export function undo(): void {
  if (transport() === 'playing') return;
  const list = past();
  if (list.length === 0) return;
  const previous = list[list.length - 1]!;
  const current = song();
  setPast(list.slice(0, -1));
  if (current) setFuture([...future(), current]);
  setSong(previous);
}

/** Replay the most recently undone edit. No-op while playing. */
export function redo(): void {
  if (transport() === 'playing') return;
  const list = future();
  if (list.length === 0) return;
  const next = list[list.length - 1]!;
  const current = song();
  setFuture(list.slice(0, -1));
  if (current) setPast([...past(), current]);
  setSong(next);
}

/** Drop both stacks. Call after loading a new file. */
export function clearHistory(): void {
  setPast([]);
  setFuture([]);
}
