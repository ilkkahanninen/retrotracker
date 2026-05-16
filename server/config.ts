import { resolve } from "node:path";

/**
 * Resource buckets exposed by the API. Each maps to a subdirectory under
 * the configured data dir and is restricted to a set of file extensions
 * by the storage layer.
 */
export type Resource = "projects" | "samples" | "modules";

export const RESOURCE_EXTENSIONS: Record<Resource, readonly string[]> = {
  projects: [".retro"],
  samples: [".wav"],
  modules: [".mod", ".xm"],
} as const;

export const RESOURCES: readonly Resource[] = [
  "projects",
  "samples",
  "modules",
] as const;

/**
 * Auth is opt-in via env vars. When `AuthConfig` is present, every CRUD
 * route requires a valid session cookie; without it the backend serves
 * a single anonymous "default" bucket at the legacy flat path.
 */
export interface AuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Raw secret bytes used to HMAC-sign session cookies. */
  cookieSecret: Uint8Array;
  /** Where to send the browser after RP-initiated logout. Defaults to "/". */
  postLogoutRedirect: string;
}

export interface BackendConfig {
  enabled: boolean;
  dataDir: string;
  auth: AuthConfig | null;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.toLowerCase());
}

/**
 * Read the 5 OIDC env vars. All-or-nothing: returns `null` if none are
 * set, throws if some are set but not all (partial config is almost
 * certainly an operator mistake we want loud). Cookie secret must be
 * at least 32 bytes after base64/utf-8 decode.
 */
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const keys = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_COOKIE_SECRET",
  ] as const;
  const present = keys.filter((k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0;
  });
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    const missing = keys.filter((k) => !present.includes(k));
    throw new Error(
      `[retrotracker] OIDC config is partial — missing: ${missing.join(", ")}. ` +
        `Set all five OIDC_* vars to enable auth, or unset them all to run anonymously.`,
    );
  }
  const cookieSecretRaw = env["OIDC_COOKIE_SECRET"]!;
  const cookieSecret = decodeCookieSecret(cookieSecretRaw);
  if (cookieSecret.byteLength < 32) {
    throw new Error(
      "[retrotracker] OIDC_COOKIE_SECRET must decode to >= 32 bytes",
    );
  }
  return {
    issuer: stripTrailingSlash(env["OIDC_ISSUER"]!),
    clientId: env["OIDC_CLIENT_ID"]!,
    clientSecret: env["OIDC_CLIENT_SECRET"]!,
    redirectUri: env["OIDC_REDIRECT_URI"]!,
    cookieSecret,
    postLogoutRedirect: env["OIDC_POST_LOGOUT_REDIRECT"] ?? "/",
  };
}

/**
 * Resolve runtime config from env. `mode` matters because dev forces the
 * backend on regardless of RETROTRACKER_BACKEND, while prod respects the
 * opt-in flag (default off, so CI-built images stay inert).
 *
 * Data layout under `dataDir`:
 *   Anonymous: <dataDir>/projects, <dataDir>/samples, <dataDir>/modules
 *   Auth on:   <dataDir>/users/<hash(sub)>/{projects,samples,modules}
 *
 * In a container we default `dataDir` to `/` so the anonymous subdirs
 * are at `/projects`, `/samples`, `/modules` for direct volume mounting.
 */
export function readConfig(
  mode: "dev" | "prod",
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const enabled = mode === "dev" || isTruthy(env["RETROTRACKER_BACKEND"]);
  const defaultDir = mode === "dev" ? resolve(process.cwd(), "data") : "/";
  const dataDir = resolve(env["RETROTRACKER_DATA_DIR"] ?? defaultDir);
  const auth = enabled ? readAuthConfig(env) : null;
  return { enabled, dataDir, auth };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Accept the secret either as plain UTF-8 text (≥ 32 chars) or as
 * base64. We probe base64 first — if it parses cleanly and yields ≥ 32
 * bytes we use the decoded form; otherwise we fall back to UTF-8.
 */
function decodeCookieSecret(raw: string): Uint8Array {
  // base64-ish heuristic
  if (/^[A-Za-z0-9+/=_-]+$/.test(raw) && raw.length >= 44) {
    try {
      // tolerate base64url
      const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64");
      if (decoded.byteLength >= 32) {
        return new Uint8Array(decoded);
      }
    } catch {
      // fall through
    }
  }
  return new Uint8Array(Buffer.from(raw, "utf8"));
}
