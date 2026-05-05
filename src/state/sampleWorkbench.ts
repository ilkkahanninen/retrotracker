import { createSignal } from "solid-js";
import type { SampleWorkbench } from "../core/audio/sampleWorkbench";

/** Per-slot map of session-only sample workbenches. */
export type WorkbenchMap = Map<number, SampleWorkbench>;

/**
 * Per-slot sample workbenches — session-only, never serialised into the
 * `.mod` file. Loading a `.mod` clears them; loading a WAV creates one for
 * the current slot. Pipeline edits update the workbench, then re-run the
 * chain into the slot's int8 data so playback (which never reads this map)
 * picks up the change.
 *
 * Implemented as a Solid signal of a fresh Map per write so component memos
 * see a new reference and re-render — Solid doesn't deeply track Map mutations.
 *
 * The signal's setter is exported (`setWorkbenchesRaw`) so the song-history
 * machinery in `state/song.ts` can snapshot/restore workbenches alongside
 * the song — that's how undo/redo of a workbench edit reverts the chain UI.
 * App-level handlers shouldn't reach for it; they go through commitEdit*.
 */
const [workbenches, setWorkbenchesRaw] = createSignal<WorkbenchMap>(new Map());

/** Read a slot's workbench; undefined when none has been loaded. */
export function getWorkbench(slot: number): SampleWorkbench | undefined {
  return workbenches().get(slot);
}

/** Replace the workbench at `slot`. */
export function setWorkbench(slot: number, wb: SampleWorkbench): void {
  const next = new Map(workbenches());
  next.set(slot, wb);
  setWorkbenchesRaw(next);
}

/** Drop the workbench at `slot` (e.g. after Clear sample). */
export function clearWorkbench(slot: number): void {
  if (!workbenches().has(slot)) return;
  const next = new Map(workbenches());
  next.delete(slot);
  setWorkbenchesRaw(next);
}

/** Drop every workbench (called when a new `.mod` is loaded). */
export function clearAllWorkbenches(): void {
  if (workbenches().size === 0) return;
  setWorkbenchesRaw(new Map());
}

/**
 * Build a new map with `slot` set to `wb`. Pure — caller passes the result
 * to `commitEditWithWorkbenches`. We expose this rather than letting callers
 * `new Map(workbenches())` themselves because the workbench-snapshot story
 * is sensitive to *who* mutates the map and *when*.
 */
export function withWorkbench(
  map: WorkbenchMap,
  slot: number,
  wb: SampleWorkbench,
): WorkbenchMap {
  const next = new Map(map);
  next.set(slot, wb);
  return next;
}

/** Pure: a copy of `map` with `slot` removed. */
export function withoutWorkbench(
  map: WorkbenchMap,
  slot: number,
): WorkbenchMap {
  if (!map.has(slot)) return map;
  const next = new Map(map);
  next.delete(slot);
  return next;
}

/** Re-export the read signal and raw setter (the latter for song-history use). */
export { workbenches, setWorkbenchesRaw };
