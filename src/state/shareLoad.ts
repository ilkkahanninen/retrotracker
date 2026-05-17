import { createSignal } from "solid-js";
import { fetchShare } from "./share";
import { loadServerBytes } from "./session";

/**
 * Token grammar — must match the regex enforced by the share route in
 * `server/shareRoutes.ts`. Tokens are 16 random bytes encoded as
 * base64url, so 22 chars in practice; the 16..32 range gives a little
 * room without accepting obviously-bogus inputs.
 */
const SHARE_PATH_RE = /^\/share\/([A-Za-z0-9_-]{16,32})$/;

export interface SharedBanner {
  filename: string;
}

/**
 * Transient banner shown above the editor when a share link was just
 * opened. Cleared by `dismissSharedBanner()` (the close button) and
 * by `applyLoadedSession` indirectly — once the user navigates to a
 * different song, the banner is no longer about the loaded content.
 */
const [sharedBanner, setSharedBanner] = createSignal<SharedBanner | null>(null);
const [shareLoadError, setShareLoadError] = createSignal<string | null>(null);

export { sharedBanner, shareLoadError };

export function dismissSharedBanner(): void {
  setSharedBanner(null);
}

export function dismissShareLoadError(): void {
  setShareLoadError(null);
}

/**
 * Detect `/share/<token>` in the page URL, strip it from history
 * immediately (so reload doesn't refetch — the share may have been
 * revoked, and we want the user's edits to survive), then fetch the
 * bytes and route them through the same loader the cloud-open and
 * drag-drop paths use.
 *
 * Designed to run once at App mount. Returns silently when the URL
 * isn't a share link.
 *
 * Errors do NOT throw — they set `shareLoadError` for the UI to
 * surface. A failed share load shouldn't break the entire app boot.
 */
export async function detectAndLoadShareLink(): Promise<void> {
  if (typeof window === "undefined") return;
  const m = window.location.pathname.match(SHARE_PATH_RE);
  if (!m) return;
  const token = m[1]!;
  // Clean the URL right away so a reload lands on the editor rather
  // than refetching the share. The user's edits survive a refresh.
  window.history.replaceState(null, "", "/");
  try {
    const { bytes, filename } = await fetchShare(token);
    // Recipients don't own the source song, so don't set cloudOrigin —
    // the "Share" menu item stays disabled until they save a copy to
    // their own cloud bucket.
    await loadServerBytes(bytes, filename);
    setSharedBanner({ filename });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setShareLoadError(`Could not open shared song: ${msg}`);
  }
}
