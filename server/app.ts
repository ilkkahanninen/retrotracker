import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  BadNameError,
  NotFoundError,
  deleteFile,
  existingSize,
  hashUserId,
  listDir,
  readFile,
  scopeUsage,
  userScope,
  writeFile,
  type UserScope,
} from "./storage.js";
import { audit, clientIp } from "./audit.js";
import {
  RESOURCES,
  RESOURCE_EXTENSIONS,
  type BackendConfig,
  type Resource,
} from "./config.js";
import { OidcClient } from "./auth/oidc.js";
import { mountAuthRoutes } from "./auth/routes.js";
import { type SessionUser, sessionMiddleware } from "./auth/middleware.js";

export interface AppDeps {
  cfg: BackendConfig;
  /** Version string surfaced by /api/health. */
  version: string;
}

const MIME: Record<Resource, string> = {
  projects: "application/json",
  samples: "audio/wav",
  modules: "application/octet-stream",
};

/**
 * Maximum upload sizes per resource. Conservative defaults chosen to fit
 * any plausible tracker payload — `.retro` (JSON wrapper around the
 * module + chiptune sources) is the largest because it can carry many
 * raw sampler WAVs. Hard caps prevent the trivial memory-DoS attack
 * where `c.req.arrayBuffer()` buffers an unbounded body.
 */
const SIZE_LIMITS: Record<Resource, number> = {
  projects: 50 * 1024 * 1024,
  samples: 50 * 1024 * 1024,
  modules: 5 * 1024 * 1024,
};

/**
 * Hono variables threaded through the request. `user` is populated by
 * `sessionMiddleware` from the signed cookie; absent in anonymous mode.
 */
export interface AppVariables {
  user: SessionUser | null;
}

/**
 * Hono app exposing project / sample / module CRUD under /api. Caller is
 * responsible for only mounting this when `cfg.enabled` — the app itself
 * trusts that gate.
 *
 * When `cfg.auth` is set every CRUD route requires a valid session
 * cookie (401 otherwise) and the per-user storage scope is built from
 * the verified `sub`. When auth is unset, a single anonymous scope at
 * the legacy flat path is used for every request.
 */
export type AppType = Hono<{ Variables: AppVariables }, never, "/api">;

export function createApp({ cfg, version }: AppDeps): AppType {
  const app = new Hono<{ Variables: AppVariables }>().basePath("/api");

  // OIDC client is lazily instantiated and shared across requests so
  // discovery + JWKS get cached. Only built when auth is configured.
  const oidc = cfg.auth
    ? new OidcClient({
        issuer: cfg.auth.issuer,
        clientId: cfg.auth.clientId,
        clientSecret: cfg.auth.clientSecret,
        redirectUri: cfg.auth.redirectUri,
      })
    : null;

  // Defence-in-depth security headers on every API response:
  //   - Cache-Control / Vary: stop CDNs from cross-serving auth-scoped
  //     responses between users.
  //   - X-Content-Type-Options: kill MIME-sniffing surprises (we control
  //     the Content-Type per resource).
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "private, no-store");
    c.res.headers.set("Vary", "Cookie");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  // sessionMiddleware sets c.var.user on every request; routes that need
  // an authenticated user run requireUser below.
  app.use("*", sessionMiddleware(cfg));

  // Origin guard on state-changing routes: when auth is on, refuse PUT
  // / DELETE / POST whose Origin header is absent or doesn't match the
  // configured redirect URI's origin. SameSite=Lax already blocks the
  // common CSRF cases; this is the belt to the suspenders.
  if (cfg.auth) {
    const expectedOrigin = safeOrigin(cfg.auth.redirectUri);
    app.use("*", originGuard(expectedOrigin));
  }

  app.get("/health", (c) => c.json({ ok: true, version }));

  app.get("/auth/status", (c) => {
    const user = c.var.user;
    return c.json({
      authRequired: cfg.auth !== null,
      user: user
        ? {
            id: user.sub,
            name: user.name ?? null,
            email: user.email ?? null,
            picture: user.picture ?? null,
          }
        : null,
    });
  });

  if (cfg.auth && oidc) {
    mountAuthRoutes(app, cfg, oidc);
  }

  for (const resource of RESOURCES) {
    const base = `/${resource}`;
    const mime = MIME[resource];
    const limit = SIZE_LIMITS[resource];

    // requireUser keeps the anonymous bucket unreachable when auth is
    // configured. In anonymous mode it's a no-op pass-through.
    app.use(`${base}`, requireUser(cfg));
    app.use(`${base}/:name{.+}`, requireUser(cfg));

    app.get(base, async (c) => {
      const scope = scopeFor(cfg, c);
      const { entries, truncated } = await listDir(scope, resource);
      return c.json({
        resource,
        extensions: RESOURCE_EXTENSIONS[resource],
        entries,
        truncated,
      });
    });

    app.get(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      try {
        const scope = scopeFor(cfg, c);
        const bytes = await readFile(scope, resource, name);
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        return c.body(ab, 200, {
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
        });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });

    app.put(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      // Reject oversized bodies upfront via Content-Length when the
      // client honours it. Below we re-check the actual byteLength as
      // the authoritative limit — a lying header doesn't help an
      // attacker because the buffered body would still trip the check
      // (and a streaming-buffer cap is the v2 hardening).
      const headerLen = c.req.header("content-length");
      if (headerLen !== undefined) {
        const n = Number(headerLen);
        if (!Number.isFinite(n) || n < 0 || n > limit) {
          return c.json(
            {
              error: "too-large",
              message: `body exceeds limit of ${limit} bytes`,
            },
            413,
          );
        }
      }
      try {
        const scope = scopeFor(cfg, c);
        const buf = await c.req.arrayBuffer();
        if (buf.byteLength > limit) {
          return c.json(
            {
              error: "too-large",
              message: `body exceeds limit of ${limit} bytes`,
            },
            413,
          );
        }
        // Per-user quota — only enforced when auth is on (anonymous mode
        // shares one bucket). Overwriting a file refunds its current
        // bytes before checking the new total.
        if (cfg.auth && cfg.userQuotaBytes > 0) {
          const current = await scopeUsage(scope);
          const existing = await existingSize(scope, resource, name);
          const after = current - existing + buf.byteLength;
          if (after > cfg.userQuotaBytes) {
            return c.json(
              {
                error: "quota-exceeded",
                message: `user quota of ${cfg.userQuotaBytes} bytes would be exceeded`,
                used: current,
                limit: cfg.userQuotaBytes,
              },
              413,
            );
          }
        }
        await writeFile(scope, resource, name, new Uint8Array(buf));
        return c.json({ ok: true, name });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });

    app.delete(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      try {
        const scope = scopeFor(cfg, c);
        await deleteFile(scope, resource, name);
        audit({
          evt: "file.delete",
          ip: clientIp(c),
          userHash: cfg.auth ? hashUserId(c.var.user!.sub) : null,
          resource,
          name,
        });
        return c.json({ ok: true, name });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });
  }

  return app;
}

/**
 * Build the per-request `UserScope`. With auth on, `c.var.user.sub`
 * is guaranteed non-null because `requireUser` runs first and 401s
 * otherwise. With auth off, we pass `null` and get the anonymous
 * flat-path scope.
 */
function scopeFor(
  cfg: BackendConfig,
  c: Context<{ Variables: AppVariables }>,
): UserScope {
  return userScope(cfg, cfg.auth ? c.var.user!.sub : null);
}

/**
 * Middleware that 401s when auth is configured but no session is
 * attached. No-op when auth is unset, so the anonymous mode behaves
 * exactly like before.
 */
function requireUser(cfg: BackendConfig) {
  return async (
    c: Context<{ Variables: AppVariables }>,
    next: Next,
  ): Promise<Response | void> => {
    if (!cfg.auth) return next();
    if (!c.var.user) {
      return c.json(
        { error: "unauthorized", message: "sign in required" },
        401,
      );
    }
    return next();
  };
}

/**
 * Reject PUT/DELETE/POST requests whose Origin header doesn't match the
 * configured redirect URI's origin. GET/HEAD/OPTIONS pass through
 * unchecked — they're not state-changing and Origin is unreliable on
 * them (Lax navs may omit it).
 *
 * Server-to-server clients (curl, fetch-without-Origin) are intentionally
 * rejected on state-changing routes: the API is browser-only today, and
 * a missing Origin is indistinguishable from a CSRF attempt.
 */
function originGuard(expectedOrigin: string | null) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    const origin = c.req.header("origin");
    if (!origin || (expectedOrigin && origin !== expectedOrigin)) {
      return c.json(
        { error: "origin-mismatch", message: "request origin not allowed" },
        403,
      );
    }
    return next();
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface ErrorBody {
  error: string;
  message: string;
}

function errorPayload(e: unknown): {
  status: ContentfulStatusCode;
  body: ErrorBody;
} {
  if (e instanceof BadNameError) {
    return { status: 400, body: { error: "bad-name", message: e.message } };
  }
  if (e instanceof NotFoundError) {
    return { status: 404, body: { error: "not-found", message: e.message } };
  }
  // Internal errors get a sanitized body — `e.message` can leak filesystem
  // paths, errno text, etc. Log the real error server-side for diagnosis.
  const real = e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-console
  console.error("[retrotracker] internal error:", real);
  return {
    status: 500,
    body: { error: "internal", message: "internal error" },
  };
}
