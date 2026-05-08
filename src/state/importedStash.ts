/**
 * Per-slot stash of the raw int8 sample (and its meta) the user had when
 * the slot was in the "Imported" state — i.e. populated from a `.mod`
 * import (or any path that left the slot with int8 but no workbench)
 * before they flipped the source-picker to Chiptune.
 *
 * The chiptune render overwrites `song.samples[slot].data`, so without
 * this stash we'd have no way to restore the original bytes when the user
 * clicks the "Imported" tab to come back. Restoring drops the chiptune
 * workbench AND replaces the slot's bytes / meta with what we captured
 * here, returning the slot to its true prior state (no workbench).
 *
 * Non-reactive Map by slot index. Session-only — never round-trips
 * through `.retro` (a freshly-loaded project either still has its int8
 * exposed as raw, or already has a workbench, so a stash is meaningless
 * across loads). Cleared on song load and per-slot operations that
 * supersede the stashed bytes (load WAV, convert to sampler workbench,
 * clear sample).
 *
 * Keyed by 0-based slot index, matching `loopStash` and the rest of the
 * per-slot maps in state/.
 */

import type { Sample } from "../core/mod/types";

const stash = new Map<number, Sample>();

/**
 * Remember the raw int8 sample currently in `slot`. Stores the Sample
 * reference directly — callers must pass an immutable snapshot, which
 * the song's reference-sharing already gives them.
 */
export function stashImportedSample(slot: number, sample: Sample): void {
  stash.set(slot, sample);
}

/** Read the stashed sample for `slot`, or `undefined` if none. */
export function getImportedStash(slot: number): Sample | undefined {
  return stash.get(slot);
}

/** Forget the stash for `slot`. Called when the stash is no longer
 *  meaningful (load WAV, convert to sampler workbench, clear sample,
 *  successful restore). */
export function clearImportedStash(slot: number): void {
  stash.delete(slot);
}

/** Forget every stash. Called on song load (`.mod` / `.retro`). */
export function clearAllImportedStashes(): void {
  stash.clear();
}
