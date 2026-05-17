import { BackendError } from "./backend";
import type { CloudResource } from "./session";

export interface ShareEntry {
  token: string;
  resource: CloudResource;
  name: string;
  createdAt: string;
  /** Relative URL (e.g. `/share/abcdef…`). The full URL is built when
   *  the modal needs to render it, so the frontend doesn't bake in an
   *  origin that might differ from the page's. */
  url: string;
}

interface CreateResponse {
  token: string;
  url: string;
  created: boolean;
  createdAt: string;
}

/**
 * Create or reuse a share link for a song in the user's own cloud
 * bucket. Idempotent server-side — clicking "Share" twice on the same
 * song returns the existing token, with `created: false`.
 */
export async function createShare(args: {
  resource: CloudResource;
  name: string;
}): Promise<CreateResponse> {
  let res: Response;
  try {
    res = await fetch("/api/shares", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(args),
    });
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CreateResponse;
}

/** List the current user's existing share links. */
export async function listMyShares(): Promise<ShareEntry[]> {
  let res: Response;
  try {
    res = await fetch("/api/shares", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { shares: ShareEntry[] };
  return body.shares;
}

/** Revoke a share by token. 404s from the server are treated as success
 *  (someone else may have already revoked, or the token never existed —
 *  either way the desired end-state is reached). */
export async function revokeShare(token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/shares/${encodeURIComponent(token)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (res.status === 404 || res.status === 204 || res.ok) return;
  throw await readError(res);
}

export interface ShareLoadResult {
  bytes: Uint8Array;
  /** Filename recovered from `Content-Disposition`, or a safe fallback
   *  derived from the token. The extension drives the sniff in
   *  `loadFile`, so we'd rather pick something with the right suffix
   *  than fall back to a generic name and have the loader guess. */
  filename: string;
}

/**
 * Fetch the bytes behind a share token. Anonymous — no `credentials`
 * needed since the backend's public GET is exempt from `requireUser`.
 */
export async function fetchShare(token: string): Promise<ShareLoadResult> {
  let res: Response;
  try {
    res = await fetch(`/api/shares/${encodeURIComponent(token)}`);
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
  const buf = await res.arrayBuffer();
  const dispo = res.headers.get("content-disposition") ?? "";
  const filename = parseDispositionFilename(dispo) ?? `shared-${token}.retro`;
  return { bytes: new Uint8Array(buf), filename };
}

async function readError(res: Response): Promise<BackendError> {
  let kind: BackendError["kind"] = "internal";
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body.error === "bad-name") kind = "bad-name";
    else if (body.error === "not-found") kind = "not-found";
    if (typeof body.message === "string") message = body.message;
  } catch {
    // body wasn't json — keep defaults
  }
  return new BackendError(kind, message);
}

/**
 * Pluck `filename="…"` out of a `Content-Disposition` header. The
 * server sets it to a sanitised leaf name (no path components), so a
 * simple unquoted-or-quoted match is sufficient. Returns null when
 * absent or malformed — caller picks a fallback.
 */
function parseDispositionFilename(value: string): string | null {
  const m = value.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1] ?? null;
  }
}
