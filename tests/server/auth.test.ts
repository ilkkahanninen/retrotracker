import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as jose from "jose";
import { createApp } from "../../server/app.js";
import { hashUserId } from "../../server/storage.js";
import { signSession } from "../../server/auth/session.js";
import { SESSION_COOKIE } from "../../server/auth/middleware.js";
import type { BackendConfig, AuthConfig } from "../../server/config.js";

const COOKIE_SECRET = new Uint8Array(32).fill(7);
const APP_ORIGIN = "https://app.test";

async function authedHarness(): Promise<{ cfg: BackendConfig; dir: string }> {
  const dir = await mkdtemp(resolve(tmpdir(), "rt-backend-auth-"));
  const auth: AuthConfig = {
    issuer: "https://example.test/oidc",
    clientId: "client-x",
    clientSecret: "secret",
    redirectUri: "https://app.test/api/auth/callback",
    cookieSecret: COOKIE_SECRET,
    postLogoutRedirect: "/",
  };
  const cfg: BackendConfig = {
    enabled: true,
    dataDir: dir,
    auth,
    userQuotaBytes: 0,
  };
  return { cfg, dir };
}

async function withCookie(token: string): Promise<{ headers: HeadersInit }> {
  return {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  };
}

describe("auth status", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("reports authRequired=true and no user when no cookie", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const res = await app.request("/api/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authRequired: true,
      user: null,
    });
  });

  it("reports authRequired=false in anonymous mode", async () => {
    const cfg: BackendConfig = {
      enabled: true,
      dataDir: harness.dir,
      auth: null,
      userQuotaBytes: 0,
    };
    const app = createApp({ cfg, version: "t" });
    const res = await app.request("/api/auth/status");
    expect(await res.json()).toEqual({
      authRequired: false,
      user: null,
    });
  });

  it("reports the signed-in user when a valid session cookie is sent", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, {
      sub: "user-42",
      name: "Alice",
      email: "a@example.test",
    });
    const res = await app.request("/api/auth/status", await withCookie(token));
    const body = (await res.json()) as {
      authRequired: boolean;
      user: { id: string; name: string | null; email: string | null } | null;
    };
    expect(body.authRequired).toBe(true);
    expect(body.user).toEqual({
      id: "user-42",
      name: "Alice",
      email: "a@example.test",
      picture: null,
    });
  });

  it("treats an invalid session cookie as signed-out", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const res = await app.request(
      "/api/auth/status",
      await withCookie("not-a-jwt"),
    );
    expect(await res.json()).toMatchObject({ user: null });
  });
});

describe("CRUD gating when auth is enabled", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("401s every CRUD route without a session cookie", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    for (const path of ["/api/projects", "/api/samples", "/api/modules"]) {
      const get = await app.request(path);
      expect(get.status).toBe(401);
    }
    const put = await app.request("/api/projects/a.retro", {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { Origin: APP_ORIGIN },
    });
    expect(put.status).toBe(401);
    const del = await app.request("/api/projects/a.retro", {
      method: "DELETE",
      headers: { Origin: APP_ORIGIN },
    });
    expect(del.status).toBe(401);
  });

  it("scopes writes under <dataDir>/users/<hash> for the signed-in user", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "user-A" });
    const put = await app.request("/api/projects/song.retro", {
      method: "PUT",
      body: new Uint8Array([9, 9, 9]),
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(put.status).toBe(200);

    const userDir = resolve(harness.dir, "users", hashUserId("user-A"));
    const onDisk = await fs.readFile(
      resolve(userDir, "projects", "song.retro"),
    );
    expect(Array.from(onDisk)).toEqual([9, 9, 9]);
  });

  it("two different subs cannot see each other's files", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const aliceToken = await signSession(COOKIE_SECRET, { sub: "alice" });
    const bobToken = await signSession(COOKIE_SECRET, { sub: "bob" });

    await app.request("/api/projects/secret.retro", {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: {
        Cookie: `${SESSION_COOKIE}=${aliceToken}`,
        Origin: APP_ORIGIN,
      },
    });

    const bobList = await app.request("/api/projects", {
      headers: { Cookie: `${SESSION_COOKIE}=${bobToken}` },
    });
    const body = (await bobList.json()) as { entries: { name: string }[] };
    expect(body.entries).toEqual([]);

    const bobRead = await app.request("/api/projects/secret.retro", {
      headers: { Cookie: `${SESSION_COOKIE}=${bobToken}` },
    });
    expect(bobRead.status).toBe(404);
  });

  it("never serves anonymous-era flat-path files when auth is on", async () => {
    // Stash a "leftover from anonymous deploy" file at the legacy path.
    await fs.mkdir(resolve(harness.dir, "projects"), { recursive: true });
    await fs.writeFile(resolve(harness.dir, "projects", "leak.retro"), "leak");

    const app = createApp({ cfg: harness.cfg, version: "t" });

    // No cookie — must 401, never a 200 listing the leaked file.
    const anonList = await app.request("/api/projects");
    expect(anonList.status).toBe(401);

    // Signed-in user — their scope is /users/<hash>, so the flat-path
    // file is invisible.
    const token = await signSession(COOKIE_SECRET, { sub: "carol" });
    const userList = await app.request("/api/projects", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    const body = (await userList.json()) as { entries: { name: string }[] };
    expect(body.entries.find((e) => e.name === "leak.retro")).toBeUndefined();
  });
});

describe("Origin guard", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("403s state-changing requests with no Origin header", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });
    const put = await app.request("/api/projects/a.retro", {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(put.status).toBe(403);
    const del = await app.request("/api/projects/a.retro", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(del.status).toBe(403);
  });

  it("403s state-changing requests from a foreign Origin", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });
    const put = await app.request("/api/projects/a.retro", {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: "https://evil.example",
      },
    });
    expect(put.status).toBe(403);
  });

  it("lets GET / HEAD through without an Origin", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    // GET /api/auth/status must work without Origin even in auth mode.
    const status = await app.request("/api/auth/status");
    expect(status.status).toBe(200);
  });
});

describe("size limits", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("413s a PUT whose Content-Length exceeds the resource limit", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });
    const tooBig = 10 * 1024 * 1024; // 10MB, exceeds modules' 5MB cap
    const res = await app.request("/api/modules/big.mod", {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
        "Content-Length": String(tooBig),
      },
    });
    expect(res.status).toBe(413);
  });

  it("413s a PUT whose actual body exceeds the resource limit", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });
    // 6MB body > 5MB modules cap (no Content-Length sent → falls
    // through to the post-buffer check).
    const big = new Uint8Array(6 * 1024 * 1024);
    const res = await app.request("/api/modules/big.mod", {
      method: "PUT",
      body: big,
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(413);
  });
});

describe("per-user disk quota", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("413s when a PUT would push the user over their quota", async () => {
    // 1 KB quota.
    harness.cfg.userQuotaBytes = 1024;
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });

    // First PUT fits.
    const small = new Uint8Array(800);
    const okRes = await app.request("/api/samples/a.wav", {
      method: "PUT",
      body: small,
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(okRes.status).toBe(200);

    // Second PUT (300 B) would total 1100 B → over the 1 KB cap.
    const second = new Uint8Array(300);
    const overRes = await app.request("/api/samples/b.wav", {
      method: "PUT",
      body: second,
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(overRes.status).toBe(413);
    expect(await overRes.json()).toMatchObject({ error: "quota-exceeded" });
  });

  it("overwriting an existing file refunds its bytes", async () => {
    harness.cfg.userQuotaBytes = 1024;
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });

    await app.request("/api/samples/a.wav", {
      method: "PUT",
      body: new Uint8Array(900),
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });

    // Same name, smaller body — should succeed even though the new
    // body plus the OLD body would have exceeded the cap.
    const replace = await app.request("/api/samples/a.wav", {
      method: "PUT",
      body: new Uint8Array(900),
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(replace.status).toBe(200);
  });
});

describe("session revocation on logout", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: harness.cfg.auth!.issuer,
            authorization_endpoint: "https://idp.test/auth",
            token_endpoint: "https://idp.test/token",
            jwks_uri: "https://idp.test/jwks",
            end_session_endpoint: "https://idp.test/end",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("rejects an old token after the same user logs out", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });

    // Build a JWT whose iat is well in the past so the 5-second grace
    // window doesn't mask the revocation.
    const oldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("alice")
      .setIssuer("retrotracker")
      .setAudience("retrotracker-spa")
      .setIssuedAt(oldIat)
      .setExpirationTime("7d")
      .sign(COOKIE_SECRET);

    // Before logout: token works.
    const before = await app.request("/api/auth/status", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((await before.json()).user).toMatchObject({ id: "alice" });

    // Logout bumps the floor.
    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: APP_ORIGIN,
      },
    });
    expect(logout.status).toBe(200);

    // Same token is now rejected.
    const after = await app.request("/api/auth/status", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((await after.json()).user).toBeNull();

    // CRUD also 401s with the revoked token.
    const crud = await app.request("/api/projects", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(crud.status).toBe(401);
  });

  it("logging out user A doesn't revoke user B's tokens", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const oldIat = Math.floor(Date.now() / 1000) - 3600;
    const aliceToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("alice")
      .setIssuer("retrotracker")
      .setAudience("retrotracker-spa")
      .setIssuedAt(oldIat)
      .setExpirationTime("7d")
      .sign(COOKIE_SECRET);
    const bobToken = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("bob")
      .setIssuer("retrotracker")
      .setAudience("retrotracker-spa")
      .setIssuedAt(oldIat)
      .setExpirationTime("7d")
      .sign(COOKIE_SECRET);

    await app.request("/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${aliceToken}`,
        Origin: APP_ORIGIN,
      },
    });

    // Bob still has a valid session.
    const bob = await app.request("/api/auth/status", {
      headers: { Cookie: `${SESSION_COOKIE}=${bobToken}` },
    });
    expect((await bob.json()).user).toMatchObject({ id: "bob" });
  });
});

describe("cache headers", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("attaches no-store + Vary on every /api response", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    const res = await app.request("/api/auth/status");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("login → callback → session", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  let realFetch: typeof fetch;
  beforeEach(async () => {
    harness = await authedHarness();
    realFetch = globalThis.fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("redirects /api/auth/login to the issuer with PKCE+state+nonce", async () => {
    const meta = {
      issuer: harness.cfg.auth!.issuer,
      authorization_endpoint: "https://idp.test/auth",
      token_endpoint: "https://idp.test/token",
      jwks_uri: "https://idp.test/jwks",
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/.well-known/openid-configuration");
      return new Response(JSON.stringify(meta), { status: 200 });
    }) as unknown as typeof fetch;

    const app = createApp({ cfg: harness.cfg, version: "t" });
    const res = await app.request("/api/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://idp.test/auth");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("client-x");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    // The flow cookies must be set so the callback can verify state.
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("rt_state=");
    expect(cookies).toContain("rt_nonce=");
    expect(cookies).toContain("rt_pkce=");
  });

  it("/api/auth/callback exchanges the code, verifies the id_token, sets a session cookie", async () => {
    // Build a signed id_token using a JWK the test controls.
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";

    const issuer = harness.cfg.auth!.issuer;
    const clientId = harness.cfg.auth!.clientId;

    const meta = {
      issuer,
      authorization_endpoint: "https://idp.test/auth",
      token_endpoint: "https://idp.test/token",
      jwks_uri: "https://idp.test/jwks",
    };

    // First the login flow to populate state / nonce / verifier cookies.
    let setCookieHeader = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/.well-known/")) {
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    }) as unknown as typeof fetch;

    const app = createApp({ cfg: harness.cfg, version: "t" });
    const login = await app.request("/api/auth/login", { redirect: "manual" });
    setCookieHeader = login.headers.get("set-cookie")!;
    const loc = new URL(login.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    const nonce = loc.searchParams.get("nonce")!;

    // Build the id_token Logto would return.
    const idToken = await new jose.SignJWT({
      nonce,
      name: "Carol",
      email: "c@example.test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject("user-carol")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    // Stub the issuer's token + JWKS endpoints.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/.well-known/")) {
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      if (url === meta.token_endpoint) {
        return new Response(
          JSON.stringify({ id_token: idToken, access_token: "at" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === meta.jwks_uri) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    }) as unknown as typeof fetch;

    // Convert the multi-value set-cookie into a Cookie request header.
    const cookieHeader = parseSetCookies(setCookieHeader);
    const cb = await app.request(
      `/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      {
        headers: { Cookie: cookieHeader },
        redirect: "manual",
      },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?auth=ok");
    const session = cb.headers.get("set-cookie")!;
    expect(session).toContain("rt_session=");

    // Use the session to hit /api/auth/status and confirm the user.
    const token = extractCookie(session, "rt_session");
    const status = await app.request("/api/auth/status", {
      headers: { Cookie: `rt_session=${token}` },
    });
    const body = (await status.json()) as {
      user: { id: string; name: string | null };
    };
    expect(body.user).toMatchObject({ id: "user-carol", name: "Carol" });
  });
});

describe("logout", () => {
  let harness: Awaited<ReturnType<typeof authedHarness>>;
  beforeEach(async () => {
    harness = await authedHarness();
  });
  afterEach(async () => {
    await rm(harness.dir, { recursive: true, force: true });
  });

  it("clears the session cookie", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: harness.cfg.auth!.issuer,
            authorization_endpoint: "https://idp.test/auth",
            token_endpoint: "https://idp.test/token",
            jwks_uri: "https://idp.test/jwks",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const app = createApp({ cfg: harness.cfg, version: "t" });
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.get("set-cookie") ?? "";
    // Clearing → Max-Age=0 or expires=epoch — Hono uses Max-Age=0.
    expect(cookies).toMatch(/rt_session=;.*Max-Age=0/);
  });
});

/** Re-encode a Set-Cookie response header into a Cookie request header. */
function parseSetCookies(setCookieHeader: string): string {
  return setCookieHeader
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/) // split on top-level cookie boundaries
    .map((c) => c.split(";")[0]!.trim())
    .filter((c) => c.includes("="))
    .join("; ");
}

function extractCookie(setCookieHeader: string, name: string): string {
  for (const part of setCookieHeader.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
    const kv = part.split(";")[0]!.trim();
    if (kv.startsWith(name + "=")) return kv.slice(name.length + 1);
  }
  throw new Error(`cookie ${name} not in ${setCookieHeader}`);
}
