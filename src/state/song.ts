import { createMemo, createSignal } from "solid-js";
import type { ModSong } from "../core/mod/types";
import type { Song } from "../core/song";
import type { XmSong } from "../core/xm/types";
import {
  workbenches as workbenchesSig,
  setWorkbenchesRaw,
  type WorkbenchMap,
} from "./sampleWorkbench";
import {
  patternNames as patternNamesSig,
  loadPatternNames,
} from "./patternNames";

/**
 * Loaded song. Held as a signal so the UI reactively re-renders on swap;
 * the song itself is not deeply reactive — pattern editing will go through
 * a dedicated store later when we wire up editing.
 *
 * Phase 3: widened from `ModSong | null` to `Song | null` (the cross-format
 * union). The vast majority of editor state still narrows to PT2 internally;
 * `pt2Song()` and `xm2Song()` below are the canonical narrowing accessors
 * for the rest of the editor.
 */
export const [song, setSong] = createSignal<Song | null>(null);

/** Narrow accessor for the loaded song when (and only when) it is PT2. */
export const pt2Song = createMemo<ModSong | null>(() => {
  const s = song();
  return s && s.format === "PT2" ? s : null;
});

/** Narrow accessor for the loaded song when (and only when) it is FT2. */
export const xm2Song = createMemo<XmSong | null>(() => {
  const s = song();
  return s && s.format === "FT2" ? s : null;
});

export type Transport = "idle" | "ready" | "playing";
export const [transport, setTransport] = createSignal<Transport>("idle");

/**
 * Which mode the transport is currently in. The header's combined Play
 * button reads this to highlight the active mode without changing its
 * label. `null` when stopped.
 */
export type PlayMode = "song" | "pattern";
export const [playMode, setPlayMode] = createSignal<PlayMode | null>(null);

/** Last (order, row) reported by the worklet — drives the pattern grid cursor. */
export const [playPos, setPlayPos] = createSignal<{
  order: number;
  row: number;
}>({ order: 0, row: 0 });

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
 * workbench map alongside the ModSong so undo/redo of a sample-pipeline edit
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
  /**
   * Snapshot of the full editable song. Widened from `ModSong` to the
   * `Song` union in Phase 3-4 to cover XM commits — `commitEditXm` pushes
   * `XmSong` snapshots through the same stack. The PT-only bookkeeping
   * (workbenches, patternNames) carries through unchanged on XM commits;
   * `applyCommit` skips updating them when format !== "PT2".
   */
  song: Song;
  workbenches: WorkbenchMap;
  /**
   * Pattern names (project-only state) bundled into the snapshot so an op
   * that re-keys patterns — Clean Up reorders/discards them — can undo
   * atomically without leaving names mapped to vanished pattern indices.
   */
  patternNames: Record<number, string>;
}

const [past, setPast] = createSignal<EditState[]>([]);
const [future, setFuture] = createSignal<EditState[]>([]);

/**
 * Pre-drag snapshot taken by `beginDragEdit`. While set, `applyCommit`
 * updates the live signals but skips its per-event history push, so a
 * slider drag (or loop-handle drag) — which fires hundreds of `commitEdit*`
 * calls — collapses into a single undo entry. `endDragEdit` pushes this
 * snapshot once and clears it.
 */
let dragSnapshot: EditState | null = null;

function pushPast(entry: EditState): void {
  const prev = past();
  const trimmed =
    prev.length >= HISTORY_LIMIT
      ? prev.slice(prev.length - HISTORY_LIMIT + 1)
      : prev;
  setPast([...trimmed, entry]);
  setFuture([]);
}

/** True if there's a prior snapshot the user can revert to. */
export const canUndo = () => past().length > 0;
/** True if there's a redo snapshot waiting. */
export const canRedo = () => future().length > 0;

/**
 * Open a coalesced edit group. While the group is open, every `commitEdit*`
 * call still updates state (so the user hears / sees the edit live), but the
 * per-event history push is deferred — `endDragEdit` records exactly one
 * entry covering the whole group. Wire to `pointerdown` on a range slider,
 * `mousedown` on a draggable handle, etc.
 *
 * Begin is idempotent while a group is already open: a second begin is a
 * no-op and does NOT install a new snapshot. Note that the *first*
 * `endDragEdit` closes the group regardless of how many begins fired, so
 * truly nested drags (e.g. multitouch on two controls) are not supported —
 * after the inner end, the outer drag's remaining commits push individual
 * undo entries. Single-pointer flows are unaffected.
 */
export function beginDragEdit(): void {
  if (dragSnapshot) return;
  const cur = song();
  if (!cur || cur.format !== "PT2") return;
  dragSnapshot = {
    song: cur,
    workbenches: workbenchesSig(),
    patternNames: patternNamesSig(),
  };
}

/**
 * Close the coalesced edit group started by `beginDragEdit`. If state
 * actually changed during the group, the pre-group snapshot is pushed onto
 * the undo stack as a single entry; otherwise no entry is recorded.
 */
export function endDragEdit(): void {
  const snap = dragSnapshot;
  dragSnapshot = null;
  if (!snap) return;
  const cur = song();
  if (!cur || cur.format !== "PT2") return;
  if (snap.song.format !== "PT2") return;
  if (
    snap.song === cur &&
    snap.workbenches === workbenchesSig() &&
    snap.patternNames === patternNamesSig()
  )
    return;
  pushPast(snap);
  setDirty(true);
}

/**
 * Internal — push a `{song, workbenches}` snapshot of the *current* live
 * state onto the past stack and apply `next`. No-op if both sides are
 * unchanged (commitEdit / commitEditWithWorkbenches each gate on their own
 * "is this actually different" check before calling, but we re-check here
 * to keep the contract local).
 *
 * No transport gate here: the playing-vs-paused policy is the caller's.
 * Pattern editors gate at `commitEdit`; sample-pipeline editors call
 * `commitEditWithWorkbenches` which intentionally allows mid-playback
 * mutations (the worklet keeps its own snapshot, so the editor's UI can
 * move ahead of what's currently audible without desync risk).
 */
function applyCommit(next: EditState): void {
  const currentSong = song();
  if (!currentSong) return;
  // The two formats can never be swapped through a commit (the picker /
  // file-load flow is the only path that changes format) — guard against
  // accidental cross-format commits at the seam.
  if (currentSong.format !== next.song.format) return;
  const currentWb = workbenchesSig();
  const currentNames = patternNamesSig();
  if (
    next.song === currentSong &&
    next.workbenches === currentWb &&
    next.patternNames === currentNames
  )
    return;

  // Inside a coalesced edit group (slider/handle drag): skip the per-event
  // history push; `endDragEdit` will record one entry for the whole drag.
  if (!dragSnapshot) {
    pushPast({
      song: currentSong,
      workbenches: currentWb,
      patternNames: currentNames,
    });
  }
  setSong(next.song);
  if (next.workbenches !== currentWb) setWorkbenchesRaw(next.workbenches);
  if (next.patternNames !== currentNames) loadPatternNames(next.patternNames);
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
export function commitEdit(transform: (song: ModSong) => ModSong): void {
  if (transport() === "playing") return;
  const current = song();
  if (!current || current.format !== "PT2") return;
  const next = transform(current);
  if (next === current) return;
  applyCommit({
    song: next,
    workbenches: workbenchesSig(),
    patternNames: patternNamesSig(),
  });
}

/**
 * XM counterpart of `commitEdit`. Runs the transform against the current
 * `XmSong` and pushes a history snapshot. Workbenches and pattern names
 * pass through untouched (FT2 has no sample workbenches yet — Phase 4 —
 * and pattern naming is PT-only). Like `commitEdit`, no-ops while playing.
 */
export function commitEditXm(transform: (song: XmSong) => XmSong): void {
  if (transport() === "playing") return;
  const current = song();
  if (!current || current.format !== "FT2") return;
  const next = transform(current);
  if (next === current) return;
  applyCommit({
    song: next,
    workbenches: workbenchesSig(),
    patternNames: patternNamesSig(),
  });
}

/**
 * Apply an immutable transform that touches both the song AND the workbench
 * map. Used by sample-pipeline operations (load WAV, add/remove/patch
 * effect, clear sample, sample-meta tweaks) so the two halves of state
 * move together — the waveform's int8 and the chain UI undo/redo as one
 * unit.
 *
 * Allowed mid-playback (unlike `commitEdit`): App.tsx wires a reactive
 * effect on `song()` that diffs each `samples[i]` reference and forwards
 * any changes through `engine.setSampleData(slot, sample)`, so the user
 * hears the edit on the next loop wrap (chiptune morph) or note trigger
 * — no need to stop and re-play. Order/pattern shape changes go the same
 * way via `engine.replaceSong`. The transform receives the live snapshot;
 * return new references for whatever changed (untouched fields can be the
 * same reference). No-op with no song.
 */
export function commitEditWithWorkbenches(
  transform: (state: PtEditState) => PtEditState,
): void {
  const current = song();
  if (!current || current.format !== "PT2") return;
  const before: PtEditState = {
    song: current,
    workbenches: workbenchesSig(),
    patternNames: patternNamesSig(),
  };
  const next = transform(before);
  if (
    next.song === before.song &&
    next.workbenches === before.workbenches &&
    next.patternNames === before.patternNames
  )
    return;
  applyCommit(next);
}

/**
 * Narrowed view of `EditState` for PT2-only callers (sample-pipeline ops).
 * Same shape, but `song` is `ModSong` so the transform doesn't need to
 * narrow on every read.
 */
interface PtEditState {
  song: ModSong;
  workbenches: WorkbenchMap;
  patternNames: Record<number, string>;
}

/** Pop the latest entry off the undo stack and restore it. No-op while playing. */
export function undo(): void {
  if (transport() === "playing") return;
  const list = past();
  if (list.length === 0) return;
  const previous = list[list.length - 1]!;
  const currentSong = song();
  const currentWb = workbenchesSig();
  const currentNames = patternNamesSig();
  // The history stack only ever contains entries matching the active
  // format (the format is locked for the lifetime of a project, and
  // `clearHistory` is called on file-load), so a mismatch here means a
  // stale entry leaked through — refuse it rather than corrupt state.
  if (currentSong && currentSong.format !== previous.song.format) return;
  setPast(list.slice(0, -1));
  if (currentSong) {
    setFuture([
      ...future(),
      {
        song: currentSong,
        workbenches: currentWb,
        patternNames: currentNames,
      },
    ]);
  }
  setSong(previous.song);
  if (previous.workbenches !== currentWb)
    setWorkbenchesRaw(previous.workbenches);
  if (previous.patternNames !== currentNames)
    loadPatternNames(previous.patternNames);
  setDirty(true);
}

/** Replay the most recently undone edit. No-op while playing. */
export function redo(): void {
  if (transport() === "playing") return;
  const list = future();
  if (list.length === 0) return;
  const next = list[list.length - 1]!;
  const currentSong = song();
  const currentWb = workbenchesSig();
  const currentNames = patternNamesSig();
  if (currentSong && currentSong.format !== next.song.format) return;
  setFuture(list.slice(0, -1));
  if (currentSong) {
    setPast([
      ...past(),
      {
        song: currentSong,
        workbenches: currentWb,
        patternNames: currentNames,
      },
    ]);
  }
  setSong(next.song);
  if (next.workbenches !== currentWb) setWorkbenchesRaw(next.workbenches);
  if (next.patternNames !== currentNames) loadPatternNames(next.patternNames);
  setDirty(true);
}

/** Drop both stacks. Call after loading a new file. */
export function clearHistory(): void {
  setPast([]);
  setFuture([]);
  dragSnapshot = null;
}
