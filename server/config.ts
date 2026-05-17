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
  /**
   * Per-user disk quota in bytes. Only enforced when auth is on (the
   * anonymous bucket is a single shared scope and a quota there doesn't
   * meaningfully bound anything). 0 disables the check.
   */
  userQuotaBytes: number;
  /**
   * PostgreSQL configuration for the share-link feature. Null when
   * `DATABASE_URL` is unset — the share API is then not mounted and the
   * frontend hides the "Share this song" menu item via the
   * `shareAvailable` flag on `/api/health`.
   */
  db: DbConfig | null;
  /** Max share links a single user may own at once. 0 disables the cap. */
  shareUserCap: number;
}

export interface DbConfig {
  dsn: string;
}

const DEFAULT_USER_QUOTA_MB = 100;
const DEFAULT_SHARE_USER_CAP = 500;

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
  const issuer = stripTrailingSlash(env["OIDC_ISSUER"]!);
  assertSecureIssuer(issuer);
  return {
    issuer,
    clientId: env["OIDC_CLIENT_ID"]!,
    clientSecret: env["OIDC_CLIENT_SECRET"]!,
    redirectUri: env["OIDC_REDIRECT_URI"]!,
    cookieSecret,
    postLogoutRedirect: env["OIDC_POST_LOGOUT_REDIRECT"] ?? "/",
  };
}

/**
 * The OIDC discovery doc + token endpoint URL come from the issuer.
 * Allowing plaintext `http://` lets a network attacker MITM the entire
 * flow (substitute keys, redirect tokens). Refuse to start unless the
 * issuer is https — with a single localhost exception for development
 * against a local IdP container.
 */
export function assertSecureIssuer(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`[retrotracker] OIDC_ISSUER is not a valid URL: ${issuer}`);
  }
  if (url.protocol === "https:") return;
  // WHATWG URL parser keeps IPv6 brackets in `hostname`, hence `[::1]`.
  const host = url.hostname;
  if (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]")
  ) {
    return;
  }
  throw new Error(
    `[retrotracker] OIDC_ISSUER must use https:// (got ${url.protocol}//${url.hostname}). ` +
      `Plaintext is only allowed for localhost.`,
  );
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
  const userQuotaBytes = readQuota(env);
  const db = enabled ? readDbConfig(env) : null;
  const shareUserCap = readShareUserCap(env);
  return { enabled, dataDir, auth, userQuotaBytes, db, shareUserCap };
}

/**
 * `DATABASE_URL` enables the share-link feature. Returns null when the
 * env var is absent or empty; never throws on parse — the pg driver
 * will surface a clearer error on first connect.
 *
 * We deliberately don't print the DSN anywhere (it can contain a
 * password); the boot log under `index.ts` only notes `db on/off`.
 */
export function readDbConfig(env: NodeJS.ProcessEnv): DbConfig | null {
  const raw = env["DATABASE_URL"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return { dsn: raw };
}

function readShareUserCap(env: NodeJS.ProcessEnv): number {
  const raw = env["RETROTRACKER_SHARE_USER_CAP"];
  if (raw === undefined) return DEFAULT_SHARE_USER_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `[retrotracker] RETROTRACKER_SHARE_USER_CAP must be a non-negative number, got ${raw}`,
    );
  }
  return Math.floor(n);
}

function readQuota(env: NodeJS.ProcessEnv): number {
  const raw = env["RETROTRACKER_USER_QUOTA_MB"];
  if (raw === undefined) return DEFAULT_USER_QUOTA_MB * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `[retrotracker] RETROTRACKER_USER_QUOTA_MB must be a non-negative number, got ${raw}`,
    );
  }
  return Math.floor(n * 1024 * 1024);
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
