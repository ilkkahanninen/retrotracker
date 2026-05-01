import { createSignal } from 'solid-js';
import type { SampleWorkbench } from '../core/audio/sampleWorkbench';

/**
 * Per-slot sample workbenches — session-only, never serialised into the
 * `.mod` file. Loading a `.mod` clears them; loading a WAV creates one for
 * the current slot. Pipeline edits update the workbench, then re-run the
 * chain into the slot's int8 data so playback (which never reads this map)
 * picks up the change.
 *
 * Implemented as a Solid signal of a fresh Map per write so component memos
 * see a new reference and re-render — Solid doesn't deeply track Map mutations.
 */
const [workbenches, setWorkbenches] = createSignal<Map<number, SampleWorkbench>>(new Map());

/** Read a slot's workbench; undefined when none has been loaded. */
export function getWorkbench(slot: number): SampleWorkbench | undefined {
  return workbenches().get(slot);
}

/** Replace the workbench at `slot`. */
export function setWorkbench(slot: number, wb: SampleWorkbench): void {
  const next = new Map(workbenches());
  next.set(slot, wb);
  setWorkbenches(next);
}

/** Drop the workbench at `slot` (e.g. after Clear sample). */
export function clearWorkbench(slot: number): void {
  if (!workbenches().has(slot)) return;
  const next = new Map(workbenches());
  next.delete(slot);
  setWorkbenches(next);
}

/** Drop every workbench (called when a new `.mod` is loaded). */
export function clearAllWorkbenches(): void {
  if (workbenches().size === 0) return;
  setWorkbenches(new Map());
}

/** Re-export the read signal so components can subscribe to map identity. */
export { workbenches };
