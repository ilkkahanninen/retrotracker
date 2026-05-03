import { onCleanup } from 'solid-js';

/**
 * Register a window-level event listener for the lifetime of the current
 * reactive owner (component setup or `createEffect` body). The listener
 * is removed automatically when the owner is disposed.
 */
export function useWindowListener<K extends keyof WindowEventMap>(
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
): void {
  window.addEventListener(type, handler);
  onCleanup(() => window.removeEventListener(type, handler));
}
