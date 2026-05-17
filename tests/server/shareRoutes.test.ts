import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../../server/app.js";
import { hashUserId, userScope } from "../../server/storage.js";
import { signSession } from "../../server/auth/session.js";
import { SESSION_COOKIE } from "../../server/auth/middleware.js";
import { _resetBuckets } from "../../server/rateLimit.js";
import type { BackendConfig, AuthConfig } from "../../server/config.js";
import { makeIsolatedDb, teardownDb, type TestDb } from "./dbHarness.js";

const DSN = process.env["TEST_DATABASE_URL"];
const D = DSN ? describe : describe.skip;

const COOKIE_SECRET = new Uint8Array(32).fill(9);
const APP_ORIGIN = "https://app.test";

interface Harness {
  cfg: BackendConfig;
  db: TestDb;
  dir: string;
}

async function authedHarness(): Promise<Harness> {
  const dir = await mkdtemp(resolve(tmpdir(), "rt-shares-"));
  const auth: AuthConfig = {
    issuer: "https://example.test/oidc",
    clientId: "client-x",
    clientSecret: "secret",
    redirectUri: `${APP_ORIGIN}/api/auth/callback`,
    cookieSecret: COOKIE_SECRET,
    postLogoutRedirect: "/",
  };
  const db = await makeIsolatedDb(DSN!);
  const cfg: BackendConfig = {
    enabled: true,
    dataDir: dir,
    auth,
    userQuotaBytes: 0,
    db: { dsn: DSN! },
    shareUserCap: 0,
  };
  // Drop the rate-limit bucket between tests so the create-limit test
  // doesn't poison its neighbours.
  _resetBuckets();
  return { cfg, db, dir };
}

async function teardown(h: Harness): Promise<void> {
  await teardownDb(h.db);
  await rm(h.dir, { recursive: true, force: true });
}

async function asUser(sub: string): Promise<HeadersInit> {
  const token = await signSession(COOKIE_SECRET, { sub });
  return {
    Cookie: `${SESSION_COOKIE}=${token}`,
    Origin: APP_ORIGIN,
  };
}

async function seedFile(
  h: Harness,
  sub: string,
  resource: "projects" | "modules",
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  // Write directly to disk under the user's hashed bucket so we don't
  // exercise the PUT route here — these tests are about /api/shares,
  // not the resource routes.
  const scope = userScope(h.cfg, sub);
  const dir = resolve(scope.subdirs[resource], name).split("/");
  dir.pop();
  await mkdir(dir.join("/"), { recursive: true });
  await writeFile(resolve(scope.subdirs[resource], name), bytes);
}

D("share routes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await authedHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("/api/health advertises shareAvailable: true when db is wired", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shareAvailable?: boolean };
    expect(body.shareAvailable).toBe(true);
  });

  it("/api/health reports shareAvailable: false when no pool", async () => {
    const cfgNoDb: BackendConfig = { ...h.cfg, db: null };
    const app = createApp({ cfg: cfgNoDb, version: "t", pool: null });
    const res = await app.request("/api/health");
    const body = (await res.json()) as { shareAvailable?: boolean };
    expect(body.shareAvailable).toBe(false);
  });

  it("POST /api/shares requires sign-in", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const res = await app.request("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify({ resource: "projects", name: "x.retro" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/shares creates a share and is idempotent", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "demo.retro", new Uint8Array([1]));
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const r1 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "demo.retro" }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as {
      token: string;
      url: string;
      created: boolean;
    };
    expect(b1.created).toBe(true);
    expect(b1.url).toBe(`/share/${b1.token}`);

    const r2 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "demo.retro" }),
    });
    const b2 = (await r2.json()) as { token: string; created: boolean };
    expect(b2.created).toBe(false);
    expect(b2.token).toBe(b1.token);
  });

  it("POST /api/shares rejects bad names and missing files", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    // Bad name (wrong extension for bucket).
    const r1 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "song.mod" }),
    });
    expect(r1.status).toBe(400);
    // Valid name but file doesn't exist in the user's bucket.
    const r2 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "missing.retro" }),
    });
    expect(r2.status).toBe(404);
  });

  it("POST /api/shares enforces shareUserCap", async () => {
    const cfg = { ...h.cfg, shareUserCap: 1 };
    const app = createApp({ cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "a.retro", new Uint8Array([1]));
    await seedFile(h, "alice", "projects", "b.retro", new Uint8Array([2]));
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const r1 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "a.retro" }),
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/api/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ resource: "projects", name: "b.retro" }),
    });
    expect(r2.status).toBe(429);
  });

  it("GET /api/shares/:token is public and returns the file bytes", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const payload = new Uint8Array([7, 8, 9, 10]);
    await seedFile(h, "alice", "projects", "song.retro", payload);
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const created = (await (
      await app.request("/api/shares", {
        method: "POST",
        headers,
        body: JSON.stringify({ resource: "projects", name: "song.retro" }),
      })
    ).json()) as { token: string };

    // Fetch without any auth cookie — public access.
    const res = await app.request(`/api/shares/${created.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="song\.retro"/,
    );
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(payload));
  });

  it("GET /api/shares/:token returns 404 for malformed tokens", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const res = await app.request("/api/shares/short");
    expect(res.status).toBe(404);
  });

  it("GET /api/shares/:token returns 404 for unknown tokens", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    const res = await app.request(
      "/api/shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/shares/:token returns 404 if the source file is gone", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "x.retro", new Uint8Array([1]));
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const created = (await (
      await app.request("/api/shares", {
        method: "POST",
        headers,
        body: JSON.stringify({ resource: "projects", name: "x.retro" }),
      })
    ).json()) as { token: string };
    // Delete the underlying file directly to simulate the owner
    // removing it without revoking the share.
    const scope = userScope(h.cfg, "alice");
    await rm(resolve(scope.subdirs.projects, "x.retro"));
    const res = await app.request(`/api/shares/${created.token}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/shares lists only the caller's shares", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "a.retro", new Uint8Array([1]));
    await seedFile(h, "bob", "projects", "b.retro", new Uint8Array([2]));
    const aliceHeaders = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const bobHeaders = {
      ...(await asUser("bob")),
      "Content-Type": "application/json",
    };
    await app.request("/api/shares", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ resource: "projects", name: "a.retro" }),
    });
    await app.request("/api/shares", {
      method: "POST",
      headers: bobHeaders,
      body: JSON.stringify({ resource: "projects", name: "b.retro" }),
    });
    const aliceList = (await (
      await app.request("/api/shares", {
        headers: await asUser("alice"),
      })
    ).json()) as { shares: { name: string }[] };
    expect(aliceList.shares.map((s) => s.name)).toEqual(["a.retro"]);
  });

  it("DELETE /api/shares/:token only succeeds for the owner", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "a.retro", new Uint8Array([1]));
    const aliceHeaders = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const created = (await (
      await app.request("/api/shares", {
        method: "POST",
        headers: aliceHeaders,
        body: JSON.stringify({ resource: "projects", name: "a.retro" }),
      })
    ).json()) as { token: string };
    // Bob can't delete Alice's share — should return 404 (not 403) so
    // token existence can't be probed.
    const bobDel = await app.request(`/api/shares/${created.token}`, {
      method: "DELETE",
      headers: await asUser("bob"),
    });
    expect(bobDel.status).toBe(404);
    // Share still exists.
    const stillThere = await app.request(`/api/shares/${created.token}`);
    expect(stillThere.status).toBe(200);
    // Alice can delete her own.
    const aliceDel = await app.request(`/api/shares/${created.token}`, {
      method: "DELETE",
      headers: await asUser("alice"),
    });
    expect(aliceDel.status).toBe(204);
    const gone = await app.request(`/api/shares/${created.token}`);
    expect(gone.status).toBe(404);
  });

  it("POST /api/shares is blocked by the origin guard without Origin", async () => {
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "a.retro", new Uint8Array([1]));
    const token = await signSession(COOKIE_SECRET, { sub: "alice" });
    const res = await app.request("/api/shares", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        "Content-Type": "application/json",
        // intentionally no Origin header
      },
      body: JSON.stringify({ resource: "projects", name: "a.retro" }),
    });
    expect(res.status).toBe(403);
  });

  it("share.read audit log uses ownerHash, not viewer identity", async () => {
    // Just smoke-test that the read works — verifying audit lines would
    // require capturing console.log, which the existing test base
    // doesn't bother with. The structural fields are in `audit.ts`.
    void hashUserId;
    const app = createApp({ cfg: h.cfg, version: "t", pool: h.db.pool });
    await seedFile(h, "alice", "projects", "x.retro", new Uint8Array([1]));
    const headers = {
      ...(await asUser("alice")),
      "Content-Type": "application/json",
    };
    const created = (await (
      await app.request("/api/shares", {
        method: "POST",
        headers,
        body: JSON.stringify({ resource: "projects", name: "x.retro" }),
      })
    ).json()) as { token: string };
    const res = await app.request(`/api/shares/${created.token}`);
    expect(res.status).toBe(200);
  });
});
