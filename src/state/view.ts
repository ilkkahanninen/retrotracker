import { createSignal } from 'solid-js';

/**
 * Top-level view selector. Three views share the main pane: the pattern
 * grid, the sample editor, and the song-info form. One is visible at a
 * time. The sample list aside is shared across all three (the cursor's
 * selected sample is what the sample editor edits, and what the pattern
 * grid stamps on note entry — the info view is read-only w.r.t. it).
 */
export type View = 'pattern' | 'sample' | 'info';

export const VIEWS: readonly View[] = ['pattern', 'sample', 'info'];

export const [view, setView] = createSignal<View>('pattern');
