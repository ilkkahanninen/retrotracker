import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "./session.js";
import { readSessionFloor, userScope } from "../storage.js";
import type { BackendConfig } from "../config.js";

/**
 * Tokens issued within this many seconds of "now" are trusted even if
 * the user's session-floor was bumped in the same window — guards
 * against a corner-case race where logout + re-login happen in the
 * same second and the new token's `iat` would otherwise tie with the
 * just-written floor. 5 s is comfortably above any plausible
 * server-to-server roundtrip while leaving a tiny window where an
 * attacker who steals a token *during* logout could still use it. For
 * a hobby-scale tracker this trade-off is fine.
 */
const REVOCATION_GRACE_SEC = 5;

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
      // Per-user revocation: a logged-out user has a `floor` written
      // into their scope dir; any token issued at or before that floor
      // is rejected. The grace window covers same-second logout/login.
      const scope = userScope(cfg, payload.sub);
      const floor = await readSessionFloor(scope);
      if (floor > 0 && payload.iat <= floor) {
        const now = Math.floor(Date.now() / 1000);
        if (now - payload.iat > REVOCATION_GRACE_SEC) {
          c.set("user", null);
          return next();
        }
      }
      c.set("user", {
        sub: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
      });
    } catch {
      c.set("user", null);
    }
    return next();
  };
}
