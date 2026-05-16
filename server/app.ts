import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  BadNameError,
  NotFoundError,
  deleteFile,
  listDir,
  readFile,
  userScope,
  writeFile,
  type UserScope,
} from "./storage.js";
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

  // sessionMiddleware sets c.var.user on every request; routes that need
  // an authenticated user run requireUser below.
  app.use("*", sessionMiddleware(cfg));

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

    // requireUser keeps the anonymous bucket unreachable when auth is
    // configured. In anonymous mode it's a no-op pass-through.
    app.use(`${base}`, requireUser(cfg));
    app.use(`${base}/:name{.+}`, requireUser(cfg));

    app.get(base, async (c) => {
      const scope = scopeFor(cfg, c);
      const entries = await listDir(scope, resource);
      return c.json({
        resource,
        extensions: RESOURCE_EXTENSIONS[resource],
        entries,
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
      try {
        const scope = scopeFor(cfg, c);
        const buf = await c.req.arrayBuffer();
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
  const message = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { error: "internal", message } };
}
