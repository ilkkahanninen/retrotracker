import type { Hono, Context, Next } from "hono";
import { audit, clientIp } from "./audit.js";
import { rateLimit } from "./rateLimit.js";
import {
  NotFoundError,
  hashUserId,
  readFile,
  resolveSafePath,
  userScope,
} from "./storage.js";
import type { BackendConfig } from "./config.js";
import type { Pool } from "./db/pool.js";
import type { AppVariables } from "./app.js";
import {
  countSharesByOwner,
  createShare,
  deleteShareByOwner,
  getShareByToken,
  listSharesByOwner,
  type ShareResource,
} from "./shares.js";
import { promises as fs } from "node:fs";

/**
 * Public token grammar — also enforced server-side in the route below
 * (the route validates *before* the DB lookup so malformed paths never
 * hit the pool). Keep this regex in sync with the SPA's `/share/<token>`
 * matcher in `src/state/shareLoad.ts`.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SHARE_RESOURCES: readonly ShareResource[] = ["projects", "modules"];

const MIME: Record<ShareResource, string> = {
  projects: "application/json",
  modules: "application/octet-stream",
};

/**
 * Mount /api/shares/* on `app`. Caller guarantees `cfg.db !== null`
 * and provides the live pool.
 *
 * Route table (kept tight on purpose — read the comments next to each
 * route for the auth posture, since this module deliberately *does
 * not* rely on a single `app.use("/shares", requireUser)` mount):
 *
 *   - GET    /api/shares/:token  PUBLIC (the whole point of sharing)
 *   - GET    /api/shares         requires user (their own list)
 *   - POST   /api/shares         requires user + origin guard
 *   - DELETE /api/shares/:token  requires user + origin guard
 *
 * The existing `originGuard` middleware in `app.ts` already filters
 * PUT/DELETE/POST when auth is on, so the state-changing share routes
 * are covered without extra wiring. The public GET stays exempt.
 */
export function mountShareRoutes<T extends Hono<{ Variables: AppVariables }>>(
  app: T,
  cfg: BackendConfig,
  pool: Pool,
): void {
  // Per-IP rate limits — token-bucket. Public read gets a higher burst
  // because a viral share legitimately fans out a lot of GETs from
  // many users, but each *individual* viewer shouldn't be able to hot-
  // loop the file off disk. Creation matches the auth-route limit
  // (cheap insurance against a signed-in account burning the cap).
  const readLimiter = rateLimit({
    scope: "share.read",
    capacity: 60,
    refillPerSec: 1, // ~60 / min sustained
  });
  const createLimiter = rateLimit({
    scope: "share.create",
    capacity: 20,
    refillPerSec: 1 / 6, // ~10 / min sustained
  });

  // PUBLIC read. Mounted before authed handlers and never wrapped in
  // requireUser — the SPA's /share/<token> page fetches this without
  // a session. We still log the read (with the *owner's* hashed sub,
  // not the viewer's) so post-hoc abuse review can identify hot files.
  app.get("/shares/:token", readLimiter, async (c) => {
    const token = c.req.param("token") ?? "";
    if (!TOKEN_RE.test(token)) {
      // 404 (not 400) so probes can't distinguish "malformed" from
      // "unknown" — both leak nothing about which tokens exist.
      return c.json({ error: "not-found", message: "share not found" }, 404);
    }
    let row;
    try {
      row = await getShareByToken(pool, token);
    } catch (e) {
      return internal(c, e);
    }
    if (!row) {
      return c.json({ error: "not-found", message: "share not found" }, 404);
    }
    const scope = userScope(cfg, row.ownerSub);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(scope, row.resource, row.name);
    } catch (e) {
      if (e instanceof NotFoundError) {
        // Source file deleted by the owner after sharing. We leave the
        // row in place (don't auto-delete on read; a transient FS
        // error would otherwise nuke valid shares) and let the owner
        // clean it up via the "Your shares" UI.
        return c.json(
          { error: "not-found", message: "shared file no longer exists" },
          404,
        );
      }
      return internal(c, e);
    }
    audit({
      evt: "share.read",
      ip: clientIp(c),
      tokenPrefix: token.slice(0, 6),
      ownerHash: hashUserId(row.ownerSub),
      resource: row.resource,
      name: row.name,
    });
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return c.body(ab, 200, {
      "Content-Type": MIME[row.resource],
      "Content-Length": String(bytes.byteLength),
      // attachment so a direct browser hit downloads the raw bytes
      // instead of trying to render JSON or guess the mime; the SPA
      // opens the song via /share/<token> (a different URL) and is
      // unaffected by this.
      "Content-Disposition": `attachment; filename="${quoteFilename(row.name)}"`,
    });
  });

  // The remaining routes need a session. Apply `requireSession` per
  // handler rather than `app.use("/shares", ...)` so the public GET
  // above is impossible to accidentally protect — the mount-order
  // trap simply doesn't exist.
  const auth = requireSession(cfg);

  app.get("/shares", auth, async (c) => {
    try {
      const ownerSub = c.var.user!.sub;
      const rows = await listSharesByOwner(pool, ownerSub);
      return c.json({
        shares: rows.map((r) => ({
          token: r.token,
          resource: r.resource,
          name: r.name,
          createdAt: r.createdAt.toISOString(),
          url: `/share/${r.token}`,
        })),
      });
    } catch (e) {
      return internal(c, e);
    }
  });

  app.post("/shares", createLimiter, auth, async (c) => {
    const ownerSub = c.var.user!.sub;
    let body: { resource?: unknown; name?: unknown };
    try {
      body = (await c.req.json()) as { resource?: unknown; name?: unknown };
    } catch {
      return c.json(
        { error: "bad-request", message: "expected JSON body" },
        400,
      );
    }
    const resource = body.resource;
    const name = body.name;
    if (!isShareResource(resource) || typeof name !== "string") {
      return c.json(
        {
          error: "bad-request",
          message:
            "expected { resource: 'projects' | 'modules', name: string }",
        },
        400,
      );
    }
    // validatePath() is run by resolveSafePath() below; do it early so
    // we return 400 (not 500) on bad names.
    let path: string;
    try {
      path = resolveSafePath(userScope(cfg, ownerSub), resource, name);
    } catch (e) {
      return c.json(
        { error: "bad-name", message: e instanceof Error ? e.message : "" },
        400,
      );
    }
    // The file must actually exist in the user's bucket — a share
    // pointing at nothing is just operator confusion.
    try {
      const st = await fs.lstat(path);
      if (!st.isFile()) {
        return c.json(
          { error: "not-found", message: "file not found in your cloud" },
          404,
        );
      }
    } catch {
      return c.json(
        { error: "not-found", message: "file not found in your cloud" },
        404,
      );
    }
    // Per-user cap. Refused on the *new* row only — re-sharing an
    // already-shared file is idempotent and doesn't grow the count.
    if (cfg.shareUserCap > 0) {
      try {
        const n = await countSharesByOwner(pool, ownerSub);
        if (n >= cfg.shareUserCap) {
          return c.json(
            {
              error: "share-limit",
              message: `share limit of ${cfg.shareUserCap} reached`,
            },
            429,
          );
        }
      } catch (e) {
        return internal(c, e);
      }
    }
    let result;
    try {
      result = await createShare(pool, { ownerSub, resource, name });
    } catch (e) {
      return internal(c, e);
    }
    audit({
      evt: "share.create",
      ip: clientIp(c),
      userHash: hashUserId(ownerSub),
      resource,
      name,
      tokenPrefix: result.row.token.slice(0, 6),
    });
    return c.json({
      token: result.row.token,
      url: `/share/${result.row.token}`,
      created: result.created,
      createdAt: result.row.createdAt.toISOString(),
    });
  });

  app.delete("/shares/:token", auth, async (c) => {
    const token = c.req.param("token") ?? "";
    if (!TOKEN_RE.test(token)) {
      // 404 here too — same reason as the public GET. Owners revoking
      // their own token will never trip this; an attacker probing
      // doesn't get to learn anything.
      return c.json({ error: "not-found", message: "share not found" }, 404);
    }
    const ownerSub = c.var.user!.sub;
    let deleted: boolean;
    try {
      deleted = await deleteShareByOwner(pool, { ownerSub, token });
    } catch (e) {
      return internal(c, e);
    }
    if (!deleted) {
      return c.json({ error: "not-found", message: "share not found" }, 404);
    }
    audit({
      evt: "share.delete",
      ip: clientIp(c),
      userHash: hashUserId(ownerSub),
      tokenPrefix: token.slice(0, 6),
    });
    return c.body(null, 204);
  });
}

function isShareResource(v: unknown): v is ShareResource {
  return typeof v === "string" && SHARE_RESOURCES.includes(v as ShareResource);
}

/**
 * Per-handler auth gate. Matches `requireUser` in `app.ts` but lives
 * here so the share-routes file can opt in/out per route — see the
 * mount-order comment above.
 */
function requireSession(cfg: BackendConfig) {
  return async (
    c: Context<{ Variables: AppVariables }>,
    next: Next,
  ): Promise<Response | void> => {
    if (!cfg.auth) {
      // When auth is off the backend has no user identity to attach a
      // share to — the feature only makes sense in auth-on mode.
      return c.json(
        {
          error: "unauthorized",
          message: "sharing requires sign-in (backend is in anonymous mode)",
        },
        401,
      );
    }
    if (!c.var.user) {
      return c.json(
        { error: "unauthorized", message: "sign in required" },
        401,
      );
    }
    return next();
  };
}

function internal(c: Context, e: unknown): Response {
  const real = e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-console
  console.error("[retrotracker] shares: internal error:", real);
  return c.json({ error: "internal", message: "internal error" }, 500);
}

/**
 * Defang the filename for `Content-Disposition`. The header grammar
 * allows quoted-string with backslash escaping; CR/LF/quote would
 * break the parser. `validatePath` already rejects most of what
 * matters but a defensive escape is cheap.
 */
function quoteFilename(name: string): string {
  // Strip directory portion — recipients see just the leaf when
  // saving locally; the slash path is internal to the owner's bucket.
  const leaf = name.split("/").pop() ?? name;
  return leaf.replace(/[\\"]/g, "_").replace(/[\r\n]/g, "");
}
