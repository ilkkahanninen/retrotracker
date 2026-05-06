/**
 * Per-slot stash of the loop window the user had configured before they
 * disabled looping. When they re-enable looping on the same slot we restore
 * those bounds instead of falling through to "loop the whole sample".
 *
 * Non-reactive: only consumed inside the loop-checkbox click handler, so a
 * Solid signal would buy no UI updates. Cleared on song load and per-slot
 * sample clear so the stash never outlives the data it described.
 *
 * Keyed by 0-based slot index (sample #1 = slot 0), matching the rest of
 * the per-slot maps in state/.
 */

interface StashedLoop {
  loopStartWords: number;
  loopLengthWords: number;
}

const stash = new Map<number, StashedLoop>();

/** Remember the current loop bounds for `slot`, overwriting any prior stash. */
export function stashLoop(slot: number, loop: StashedLoop): void {
  stash.set(slot, { ...loop });
}

/** Read the stashed bounds for `slot`, or `undefined` if none. Non-consuming. */
export function getStashedLoop(slot: number): StashedLoop | undefined {
  return stash.get(slot);
}

/** Forget the stash for `slot`. Called on per-slot sample clear. */
export function clearStashedLoop(slot: number): void {
  stash.delete(slot);
}

/** Forget every stash. Called on song load (`.mod` / `.retro`). */
export function clearAllStashedLoops(): void {
  stash.clear();
}
