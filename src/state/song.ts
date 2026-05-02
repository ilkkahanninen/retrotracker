import { createSignal } from 'solid-js';
import type { Song } from '../core/mod/types';
import {
  workbenches as workbenchesSig, setWorkbenchesRaw,
  type WorkbenchMap,
} from './sampleWorkbench';

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
 * "Has the song been edited since the last save / load?" Drives the
 * confirm-before-discard prompt on File → New. We set this from any
 * commit / undo / redo (i.e. any path that mutates the song through
 * the history machinery), and File → New / Open / Save clear it.
 *
 * Conservative by design: undo back to the saved state still flips
 * dirty=true here. We'd need to compare against a saved snapshot to
 * detect "back to clean", which isn't worth the bookkeeping vs. an
 * occasional unnecessary prompt.
 */
export const [dirty, setDirty] = createSignal(false);

/**
 * Edit history.
 *
 * Snapshot-based: each commit pushes a `{ song, workbenches }` tuple onto
 * the past stack and replaces both signals with the new ones. We bundle the
 * workbench map alongside the Song so undo/redo of a sample-pipeline edit
 * reverts BOTH the chain (visible in the pipeline UI) and the int8 data
 * (visible in the waveform) atomically — without this, undoing an effect
 * would silently desync the editor: the chain stayed at its post-edit state
 * while the waveform jumped back to the pre-edit int8.
 *
 * Edits should be immutable (return new references). Workbenches are
 * compared/restored by Map identity — `withWorkbench` / `withoutWorkbench`
 * over in `state/sampleWorkbench.ts` produce fresh maps for that reason.
 *
 * History is capped to keep memory bounded; older entries fall off the bottom.
 * Loading a different file calls `clearHistory` so undo doesn't reach across
 * file boundaries.
 */
export const HISTORY_LIMIT = 200;

interface EditState {
  song: Song;
  workbenches: WorkbenchMap;
}

const [past, setPast] = createSignal<EditState[]>([]);
const [future, setFuture] = createSignal<EditState[]>([]);

/** True if there's a prior snapshot the user can revert to. */
export const canUndo = () => past().length > 0;
/** True if there's a redo snapshot waiting. */
export const canRedo = () => future().length > 0;

/**
 * Internal — push a `{song, workbenches}` snapshot of the *current* live
 * state onto the past stack and apply `next`. No-op if both sides are
 * unchanged (commitEdit / commitEditWithWorkbenches each gate on their own
 * "is this actually different" check before calling, but we re-check here
 * to keep the contract local).
 */
function applyCommit(next: EditState): void {
  if (transport() === 'playing') return;
  const currentSong = song();
  if (!currentSong) return;
  const currentWb = workbenchesSig();
  if (next.song === currentSong && next.workbenches === currentWb) return;

  const prev = past();
  const trimmed = prev.length >= HISTORY_LIMIT
    ? prev.slice(prev.length - HISTORY_LIMIT + 1)
    : prev;
  setPast([...trimmed, { song: currentSong, workbenches: currentWb }]);
  setFuture([]);
  setSong(next.song);
  if (next.workbenches !== currentWb) setWorkbenchesRaw(next.workbenches);
  setDirty(true);
}

/**
 * Apply an immutable transform to the current song. Workbenches are carried
 * across unchanged — pattern edits don't touch them, but they're still part
 * of the snapshot we push, so a subsequent undo restores the workbench state
 * that was live at this commit.
 *
 * No-op if no song is loaded, the transform returns the same reference, or
 * the transport is currently playing.
 */
export function commitEdit(transform: (song: Song) => Song): void {
  if (transport() === 'playing') return;
  const current = song();
  if (!current) return;
  const next = transform(current);
  if (next === current) return;
  applyCommit({ song: next, workbenches: workbenchesSig() });
}

/**
 * Apply an immutable transform that touches both the song AND the workbench
 * map. Used by sample-pipeline operations (load WAV, add/remove/patch
 * effect, clear sample) so the two halves of state move together — the
 * waveform's int8 and the chain UI undo/redo as one unit.
 *
 * No-op while playing or with no song. The transform receives the live
 * snapshot; return new references for whatever changed (untouched fields
 * can be the same reference).
 */
export function commitEditWithWorkbenches(
  transform: (state: EditState) => EditState,
): void {
  if (transport() === 'playing') return;
  const current = song();
  if (!current) return;
  const before: EditState = { song: current, workbenches: workbenchesSig() };
  const next = transform(before);
  if (next.song === before.song && next.workbenches === before.workbenches) return;
  applyCommit(next);
}

/** Pop the latest entry off the undo stack and restore it. No-op while playing. */
export function undo(): void {
  if (transport() === 'playing') return;
  const list = past();
  if (list.length === 0) return;
  const previous = list[list.length - 1]!;
  const currentSong = song();
  const currentWb = workbenchesSig();
  setPast(list.slice(0, -1));
  if (currentSong) {
    setFuture([...future(), { song: currentSong, workbenches: currentWb }]);
  }
  setSong(previous.song);
  if (previous.workbenches !== currentWb) setWorkbenchesRaw(previous.workbenches);
  setDirty(true);
}

/** Replay the most recently undone edit. No-op while playing. */
export function redo(): void {
  if (transport() === 'playing') return;
  const list = future();
  if (list.length === 0) return;
  const next = list[list.length - 1]!;
  const currentSong = song();
  const currentWb = workbenchesSig();
  setFuture(list.slice(0, -1));
  if (currentSong) {
    setPast([...past(), { song: currentSong, workbenches: currentWb }]);
  }
  setSong(next.song);
  if (next.workbenches !== currentWb) setWorkbenchesRaw(next.workbenches);
  setDirty(true);
}

/** Drop both stacks. Call after loading a new file. */
export function clearHistory(): void {
  setPast([]);
  setFuture([]);
}
