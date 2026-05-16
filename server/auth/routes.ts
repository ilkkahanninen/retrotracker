import type { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { generatePkce, randomToken, type OidcClient } from "./oidc.js";
import { signSession, verifySession } from "./session.js";
import { SESSION_COOKIE, type SessionUser } from "./middleware.js";
import { userScope, writeSessionFloor } from "../storage.js";
import type { BackendConfig } from "../config.js";

const STATE_COOKIE = "rt_state";
const NONCE_COOKIE = "rt_nonce";
const VERIFIER_COOKIE = "rt_pkce";
const FLOW_COOKIE_MAX_AGE = 600; // 10 minutes

/**
 * Mount /api/auth/login, /callback, /logout. Caller has already
 * ensured `cfg.auth` is non-null.
 */
export function mountAuthRoutes<
  T extends Hono<{ Variables: { user: SessionUser | null } }>,
>(app: T, cfg: BackendConfig, oidc: OidcClient): void {
  const authCfg = cfg.auth!;

  app.get("/auth/login", async (c) => {
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = generatePkce();

    const cookieOpts = transientCookie(authCfg.redirectUri);
    setCookie(c, STATE_COOKIE, state, cookieOpts);
    setCookie(c, NONCE_COOKIE, nonce, cookieOpts);
    setCookie(c, VERIFIER_COOKIE, verifier, cookieOpts);

    const url = await oidc.buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge: challenge,
    });
    return c.redirect(url);
  });

  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      return c.json({ error: "oidc-error", message: error }, 400);
    }
    if (!code || !state) {
      return c.json(
        { error: "bad-callback", message: "missing code/state" },
        400,
      );
    }

    const savedState = getCookie(c, STATE_COOKIE);
    const savedNonce = getCookie(c, NONCE_COOKIE);
    const savedVerifier = getCookie(c, VERIFIER_COOKIE);
    deleteCookie(c, STATE_COOKIE, transientCookie(authCfg.redirectUri));
    deleteCookie(c, NONCE_COOKIE, transientCookie(authCfg.redirectUri));
    deleteCookie(c, VERIFIER_COOKIE, transientCookie(authCfg.redirectUri));

    if (!savedState || savedState !== state) {
      return c.json(
        { error: "state-mismatch", message: "state cookie missing or stale" },
        400,
      );
    }
    if (!savedNonce || !savedVerifier) {
      return c.json(
        { error: "flow-state-missing", message: "auth flow cookies expired" },
        400,
      );
    }

    let user;
    try {
      user = await oidc.exchangeCode({
        code,
        codeVerifier: savedVerifier,
        expectedNonce: savedNonce,
      });
    } catch (e) {
      // Sanitize: the upstream error text from the IdP could leak
      // internal endpoint details. Log it server-side, return a
      // generic 400 to the client.
      // eslint-disable-next-line no-console
      console.error(
        "[retrotracker] token exchange failed:",
        e instanceof Error ? e.message : String(e),
      );
      return c.json(
        { error: "token-exchange-failed", message: "sign-in failed" },
        400,
      );
    }

    const sessionToken = await signSession(authCfg.cookieSecret, user);
    setCookie(
      c,
      SESSION_COOKIE,
      sessionToken,
      sessionCookieOpts(authCfg.redirectUri),
    );

    // Redirect back to the SPA root. `?auth=ok` is a marker the frontend
    // strips after refreshing its auth status — useful for popping a
    // "signed in" toast later without re-running the redirect dance.
    return c.redirect("/?auth=ok");
  });

  app.post("/auth/logout", async (c) => {
    // Bump the user's session floor before clearing the cookie. Every
    // JWT they currently hold (this tab + any leaked copy) becomes
    // invalid on the next request because its `iat` is now <= floor.
    // Best-effort: if the cookie is missing/invalid there's nothing to
    // revoke and we just clear and move on.
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      try {
        const payload = await verifySession(authCfg.cookieSecret, token);
        const scope = userScope(cfg, payload.sub);
        await writeSessionFloor(scope, Math.floor(Date.now() / 1000));
      } catch {
        // invalid token — nothing to revoke
      }
    }
    deleteCookie(c, SESSION_COOKIE, sessionCookieOpts(authCfg.redirectUri));
    const endSession = await oidc.endSessionUrl(authCfg.postLogoutRedirect);
    return c.json({ ok: true, endSessionUrl: endSession });
  });
}

/** Cookie options for short-lived flow state (state / nonce / verifier). */
function transientCookie(redirectUri: string) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: redirectUri.startsWith("https://"),
    path: "/",
    maxAge: FLOW_COOKIE_MAX_AGE,
  };
}

/** Cookie options for the long-lived session cookie. */
function sessionCookieOpts(redirectUri: string) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: redirectUri.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}
