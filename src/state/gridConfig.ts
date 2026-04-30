import { createSignal } from 'solid-js';

/**
 * Pattern-grid metric: how many rows make a beat, and how many beats make
 * a bar. Drives the beat/bar background accents in PatternGrid.
 *
 * Defaults match standard MOD usage (4 rows per beat, 4 beats per bar →
 * a bar every 16 rows). No UI to change these yet — exported as signals so
 * a future settings panel can flip them at runtime.
 */
export const [rowsPerBeat, setRowsPerBeat] = createSignal(4);
export const [beatsPerBar, setBeatsPerBar] = createSignal(4);
