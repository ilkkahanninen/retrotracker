import { createSignal } from 'solid-js';

/**
 * Top-level view selector. Four views share the main pane: the pattern
 * grid, the sample editor, the song-info form, and app settings. One is
 * visible at a time. The sample list aside is shared with pattern/sample
 * (the cursor's selected sample is what the sample editor edits, and
 * what the pattern grid stamps on note entry); info and settings drop
 * the sample list entirely.
 */
export type View = 'pattern' | 'sample' | 'info' | 'settings';

export const VIEWS: readonly View[] = ['pattern', 'sample', 'info', 'settings'];

export const [view, setView] = createSignal<View>('pattern');
