import { createSignal } from "solid-js";

/**
 * User-given pattern names — project-only state. They round-trip through
 * `.retro` projects (alongside the song bytes) but are NEVER serialised
 * into the exported `.mod` since the M.K. format has no place for them.
 *
 * Keyed by 0-based pattern index (matches `Song.patterns[i]`), NOT by
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
  if (patternIndex < 0) return;
  const trimmed = name.slice(0, PATTERN_NAME_MAX);
  setPatternNamesRaw((prev) => {
    const next = { ...prev };
    if (trimmed.trim() === "") delete next[patternIndex];
    else next[patternIndex] = trimmed;
    return next;
  });
}

/** Drop every pattern name. Called when the song is replaced (Open / New). */
export function resetPatternNames(): void {
  setPatternNamesRaw({});
}

/** Bulk-restore (used by `applyLoadedSession`). */
export function loadPatternNames(map: Record<number, string>): void {
  setPatternNamesRaw({ ...map });
}
