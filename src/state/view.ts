import { createSignal } from 'solid-js';

/**
 * Top-level view selector. The pattern grid and the sample editor occupy
 * the same screen real estate; one is visible at a time. The sample list
 * pane is shared across both views (the cursor's selected sample is what
 * the sample editor edits, and what the pattern grid stamps on note entry).
 */
export type View = 'pattern' | 'sample';

export const [view, setView] = createSignal<View>('pattern');
