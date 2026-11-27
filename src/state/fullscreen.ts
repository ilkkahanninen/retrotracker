import { createSignal } from "solid-js";

/**
 * Browser fullscreen for the whole app (Fullscreen API on the root
 * element). The signal mirrors `document.fullscreenElement`, so it also
 * follows exits the app didn't initiate — Esc, or the browser's own UI.
 */

const hasDocument = typeof document !== "undefined";

/** False where the API is missing or blocked (e.g. iPhone Safari, or an
 *  iframe without `allow="fullscreen"`); the menu item disables itself. */
export const fullscreenSupported: boolean =
  hasDocument &&
  document.fullscreenEnabled === true &&
  typeof document.documentElement.requestFullscreen === "function";

const [isFullscreen, setIsFullscreen] = createSignal(
  hasDocument && !!document.fullscreenElement,
);
export { isFullscreen };

if (hasDocument) {
  document.addEventListener("fullscreenchange", () => {
    setIsFullscreen(!!document.fullscreenElement);
  });
}

export function toggleFullscreen(): void {
  if (!fullscreenSupported) return;
  // Both calls reject when the browser refuses (no user gesture, permission
  // policy). Nothing to recover — the signal simply never flips.
  const done = document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen();
  done.catch(() => undefined);
}
