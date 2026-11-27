import { createSignal } from "solid-js";

/**
 * User-given pattern names — project-only state, shared by PT and FT2
 * songs. They round-trip through `.retro` projects (alongside the song
 * bytes) but are NEVER serialised into the exported `.mod` / `.xm` since
 * neither format has a place for them.
 *
 * Keyed by 0-based pattern index (matches `song.patterns[i]`), NOT by
 * order-list position — so naming pattern $03 makes that name show up
 * everywhere $03 appears in the order list.
 */

export const PATTERN_NAME_MAX = 24;

const [patternNames, setPatternNamesRaw] = createSignal<Record<number, string>>(
  {},
);

export { patternNames };

/**
 * Set a pattern's name; pass an empty / whitespace-only string to clear
 * the entry entirely (so the order list falls back to showing nothing
 * rather than a blank line). Truncated to PATTERN_NAME_MAX so a
 * runaway paste can't blow out the order-list layout.
 */
export function setPatternName(patternIndex: number, name: string): void {
  setPatternNamesRaw((prev) => withPatternName(prev, patternIndex, name));
}

/**
 * Pure form of `setPatternName`: returns the map with `patternIndex`
 * named (or un-named, for a blank string). Returns the SAME reference
 * when nothing changes, so history commits can detect a no-op. Used by
 * `renamePattern` to route renames through the undo history.
 */
export function withPatternName(
  map: Record<number, string>,
  patternIndex: number,
  name: string,
): Record<number, string> {
  if (patternIndex < 0) return map;
  const trimmed = name.slice(0, PATTERN_NAME_MAX);
  const blank = trimmed.trim() === "";
  if (blank ? !(patternIndex in map) : map[patternIndex] === trimmed) {
    return map;
  }
  const next = { ...map };
  if (blank) delete next[patternIndex];
  else next[patternIndex] = trimmed;
  return next;
}

/**
 * Re-key the map after a pattern renumbering (Order → Clean up). `remap`
 * maps old pattern index → new; names of patterns it dropped are dropped
 * with them.
 */
export function remapPatternNames(
  map: Record<number, string>,
  remap: ReadonlyArray<number | undefined>,
): Record<number, string> {
  const next: Record<number, string> = {};
  for (const key of Object.keys(map)) {
    const oldIdx = Number(key);
    const newIdx = remap[oldIdx];
    if (newIdx !== undefined) next[newIdx] = map[oldIdx]!;
  }
  return next;
}

/** Drop every pattern name. Called when the song is replaced (Open / New). */
export function resetPatternNames(): void {
  setPatternNamesRaw({});
}

/** Bulk-restore (used by `applyLoadedSession`). */
export function loadPatternNames(map: Record<number, string>): void {
  setPatternNamesRaw({ ...map });
}
