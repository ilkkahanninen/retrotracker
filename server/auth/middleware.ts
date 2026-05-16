import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "./session.js";
import type { BackendConfig } from "../config.js";

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

export const SESSION_COOKIE = "rt_session";

/**
 * Hono middleware that reads + verifies the session cookie. Sets
 * `c.var.user` to the decoded payload on success, `null` otherwise.
 * In anonymous mode (no auth config) it short-circuits to `null` —
 * downstream `requireUser` is a no-op.
 *
 * A failed-verify is treated identically to a missing cookie: the
 * user is unauthenticated. We don't try to refresh expired sessions
 * here; the SPA hits `/api/auth/login` to start a fresh flow when its
 * status probe returns no user.
 */
export function sessionMiddleware(cfg: BackendConfig) {
  return async (
    c: Context<{ Variables: { user: SessionUser | null } }>,
    next: Next,
  ): Promise<Response | void> => {
    if (!cfg.auth) {
      c.set("user", null);
      return next();
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      c.set("user", null);
      return next();
    }
    try {
      const payload = await verifySession(cfg.auth.cookieSecret, token);
      c.set("user", payload);
    } catch {
      c.set("user", null);
    }
    return next();
  };
}
