import { createSignal } from "solid-js";

export interface CloudUser {
  id: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

const [authRequired, setAuthRequired] = createSignal(false);
const [currentUser, setCurrentUser] = createSignal<CloudUser | null>(null);
const [authReady, setAuthReady] = createSignal(false);

export { authRequired, currentUser, authReady };

/**
 * Whether the cloud entries should appear in the UI. Backend up AND
 * (auth disabled OR user signed in). The probe layer sets the flag for
 * "backend up"; this derived helper layers auth on top.
 */
export function cloudVisibleFor(backendAvailable: boolean): boolean {
  if (!backendAvailable) return false;
  if (!authRequired()) return true;
  return currentUser() !== null;
}

interface AuthStatusBody {
  authRequired: boolean;
  user: CloudUser | null;
}

/**
 * Fetch `/api/auth/status` and apply it to the auth signals. Called by
 * `probeBackend()` on boot, and after `/api/auth/callback` redirects
 * back with `?auth=ok`.
 */
export async function refreshAuth(): Promise<void> {
  try {
    const res = await fetch("/api/auth/status", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      setAuthRequired(false);
      setCurrentUser(null);
      setAuthReady(true);
      return;
    }
    const body = (await res.json()) as AuthStatusBody;
    setAuthRequired(!!body.authRequired);
    setCurrentUser(body.user ?? null);
  } catch {
    setAuthRequired(false);
    setCurrentUser(null);
  } finally {
    setAuthReady(true);
  }
}

/** Hard navigation to the backend's login endpoint. */
export function login(): void {
  window.location.assign("/api/auth/login");
}

/**
 * Clear the session cookie server-side, then refresh local state. If
 * the backend has an end-session URL (Logto does), we follow it so the
 * user is logged out of the IdP too — otherwise just refresh.
 */
export async function logout(): Promise<void> {
  try {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (res.ok) {
      const body = (await res.json()) as { endSessionUrl?: string | null };
      if (body.endSessionUrl) {
        window.location.assign(body.endSessionUrl);
        return;
      }
    }
  } catch {
    // ignore; we'll still update local state below
  }
  setCurrentUser(null);
  await refreshAuth();
}
