import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countSharesByOwner,
  createShare,
  deleteShareByOwner,
  getShareByToken,
  listSharesByOwner,
  mintToken,
} from "../../server/shares.js";
import { makeIsolatedDb, teardownDb, type TestDb } from "./dbHarness.js";

const DSN = process.env["TEST_DATABASE_URL"];

// When TEST_DATABASE_URL is unset, skip the whole suite so CI without
// a live PG stays green. Local dev: `docker run --rm -e
// POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16` and export the URL.
const D = DSN ? describe : describe.skip;

D("shares data access", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await makeIsolatedDb(DSN!);
  });
  afterEach(async () => {
    await teardownDb(db);
  });

  it("mintToken returns a 22-char base64url string", () => {
    const t = mintToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Tokens are random — two consecutive mints should differ with
    // overwhelming probability. (128 bits of entropy → collision
    // probability is astronomically low.)
    expect(mintToken()).not.toBe(t);
  });

  it("createShare inserts a new row and returns created=true", async () => {
    const r = await createShare(db.pool, {
      ownerSub: "user-alpha",
      resource: "projects",
      name: "demo.retro",
    });
    expect(r.created).toBe(true);
    expect(r.row.ownerSub).toBe("user-alpha");
    expect(r.row.resource).toBe("projects");
    expect(r.row.name).toBe("demo.retro");
    expect(r.row.token).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    expect(r.row.createdAt).toBeInstanceOf(Date);
  });

  it("createShare is idempotent on (owner, resource, name)", async () => {
    const a = await createShare(db.pool, {
      ownerSub: "u1",
      resource: "projects",
      name: "song.retro",
    });
    const b = await createShare(db.pool, {
      ownerSub: "u1",
      resource: "projects",
      name: "song.retro",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.row.token).toBe(a.row.token);
  });

  it("different owners sharing the same name get distinct tokens", async () => {
    const a = await createShare(db.pool, {
      ownerSub: "alice",
      resource: "modules",
      name: "intro.mod",
    });
    const b = await createShare(db.pool, {
      ownerSub: "bob",
      resource: "modules",
      name: "intro.mod",
    });
    expect(a.row.token).not.toBe(b.row.token);
  });

  it("getShareByToken round-trips by token", async () => {
    const created = await createShare(db.pool, {
      ownerSub: "u",
      resource: "modules",
      name: "x.xm",
    });
    const fetched = await getShareByToken(db.pool, created.row.token);
    expect(fetched).not.toBeNull();
    expect(fetched!.ownerSub).toBe("u");
    expect(fetched!.resource).toBe("modules");
    expect(fetched!.name).toBe("x.xm");
  });

  it("getShareByToken returns null for unknown tokens", async () => {
    const r = await getShareByToken(db.pool, "not-a-real-token-xxxx");
    expect(r).toBeNull();
  });

  it("deleteShareByOwner removes the row when owner matches", async () => {
    const r = await createShare(db.pool, {
      ownerSub: "u",
      resource: "projects",
      name: "y.retro",
    });
    const deleted = await deleteShareByOwner(db.pool, {
      ownerSub: "u",
      token: r.row.token,
    });
    expect(deleted).toBe(true);
    expect(await getShareByToken(db.pool, r.row.token)).toBeNull();
  });

  it("deleteShareByOwner refuses to delete another user's share", async () => {
    const r = await createShare(db.pool, {
      ownerSub: "alice",
      resource: "projects",
      name: "private.retro",
    });
    const deleted = await deleteShareByOwner(db.pool, {
      ownerSub: "bob",
      token: r.row.token,
    });
    expect(deleted).toBe(false);
    // The row is still there.
    expect(await getShareByToken(db.pool, r.row.token)).not.toBeNull();
  });

  it("listSharesByOwner filters to one user and orders newest first", async () => {
    const a = await createShare(db.pool, {
      ownerSub: "alice",
      resource: "projects",
      name: "first.retro",
    });
    // Brief gap so created_at differs deterministically.
    await new Promise((r) => setTimeout(r, 10));
    const b = await createShare(db.pool, {
      ownerSub: "alice",
      resource: "modules",
      name: "second.mod",
    });
    await createShare(db.pool, {
      ownerSub: "bob",
      resource: "projects",
      name: "other.retro",
    });
    const list = await listSharesByOwner(db.pool, "alice");
    expect(list.map((r) => r.token)).toEqual([b.row.token, a.row.token]);
  });

  it("countSharesByOwner counts only that user's shares", async () => {
    await createShare(db.pool, {
      ownerSub: "alice",
      resource: "projects",
      name: "a.retro",
    });
    await createShare(db.pool, {
      ownerSub: "alice",
      resource: "modules",
      name: "b.mod",
    });
    await createShare(db.pool, {
      ownerSub: "bob",
      resource: "projects",
      name: "c.retro",
    });
    expect(await countSharesByOwner(db.pool, "alice")).toBe(2);
    expect(await countSharesByOwner(db.pool, "bob")).toBe(1);
    expect(await countSharesByOwner(db.pool, "nobody")).toBe(0);
  });
});
