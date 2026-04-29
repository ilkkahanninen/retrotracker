import { createSignal } from 'solid-js';
import type { Song } from '../core/mod/types';

/**
 * Loaded song. Held as a signal so the UI reactively re-renders on swap;
 * the Song itself is not deeply reactive — pattern editing will go through
 * a dedicated store later when we wire up editing.
 */
export const [song, setSong] = createSignal<Song | null>(null);

export type Transport = 'idle' | 'ready' | 'playing';
export const [transport, setTransport] = createSignal<Transport>('idle');

/** Last (order, row) reported by the worklet — drives the pattern grid cursor. */
export const [playPos, setPlayPos] = createSignal<{ order: number; row: number }>({ order: 0, row: 0 });
