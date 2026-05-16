import { createSignal } from "solid-js";

/**
 * Resource buckets exposed by the optional Node backend. Match the
 * server-side `Resource` union — keep these strings in sync if either
 * side adds a new bucket.
 */
export type BackendResource = "projects" | "samples" | "modules";

export interface BackendEntry {
  /** Slash-separated path relative to the resource root. */
  name: string;
  size: number;
  /** ms since epoch. */
  mtime: number;
}

interface ListResponse {
  resource: BackendResource;
  extensions: string[];
  entries: BackendEntry[];
}

const [backendAvailable, setBackendAvailable] = createSignal(false);
const [serverVersion, setServerVersion] = createSignal<string | null>(null);

export { backendAvailable, serverVersion };

/**
 * One-shot health check on app boot. The backend is optional and we
 * never want a failed ping to surface as an error to the user — a
 * thrown fetch or non-200 just means "no server mode available".
 */
export async function probeBackend(): Promise<void> {
  try {
    const res = await fetch("/api/health", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (body.ok) {
      setBackendAvailable(true);
      setServerVersion(body.version ?? null);
    }
  } catch {
    // network error, CORS, parse error — backend simply stays unavailable.
  }
}

/**
 * Errors returned by the backend client. `kind` distinguishes the
 * semantic cases the UI cares about so dialogs can react without
 * pattern-matching on the message.
 */
export class BackendError extends Error {
  constructor(
    public readonly kind: "bad-name" | "not-found" | "network" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
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

export async function listEntries(
  resource: BackendResource,
): Promise<BackendEntry[]> {
  let res: Response;
  try {
    res = await fetch(`/api/${resource}`);
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as ListResponse;
  return body.entries;
}

export async function getBytes(
  resource: BackendResource,
  name: string,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(`/api/${resource}/${encodePath(name)}`);
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function putBytes(
  resource: BackendResource,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  let res: Response;
  try {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    res = await fetch(`/api/${resource}/${encodePath(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: ab,
    });
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
}

export async function deleteEntry(
  resource: BackendResource,
  name: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/${resource}/${encodePath(name)}`, {
      method: "DELETE",
    });
  } catch (e) {
    throw new BackendError(
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw await readError(res);
}

/**
 * Encode a slash-separated relative path for use in a URL. Each segment
 * is URI-encoded; the slashes themselves stay raw because the server
 * route is a `:name{.+}` capture.
 */
function encodePath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}
