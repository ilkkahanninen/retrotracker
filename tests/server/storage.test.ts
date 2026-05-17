import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import {
  BadNameError,
  NotFoundError,
  deleteFile,
  ensureDirs,
  hashUserId,
  listDir,
  readFile,
  resolveSafePath,
  userScope,
  validatePath,
  writeFile,
  type UserScope,
} from "../../server/storage.js";
import type { BackendConfig } from "../../server/config.js";

interface Harness {
  cfg: BackendConfig;
  scope: UserScope;
}

async function tempHarness(): Promise<Harness> {
  const dir = await mkdtemp(resolve(tmpdir(), "rt-backend-"));
  const cfg: BackendConfig = {
    enabled: true,
    dataDir: dir,
    auth: null,
    userQuotaBytes: 0,
    db: null,
    shareUserCap: 0,
  };
  return { cfg, scope: userScope(cfg, null) };
}

describe("validatePath", () => {
  it("accepts plain leaf filenames with the right extension", () => {
    expect(() => validatePath("projects", "song.retro")).not.toThrow();
    expect(() => validatePath("samples", "kick.wav")).not.toThrow();
    expect(() => validatePath("modules", "intro.mod")).not.toThrow();
    expect(() => validatePath("modules", "intro.xm")).not.toThrow();
  });

  it("accepts nested subdirectory paths", () => {
    expect(() =>
      validatePath("projects", "demos/2026/intro.retro"),
    ).not.toThrow();
    expect(() => validatePath("samples", "drums/kick.wav")).not.toThrow();
  });

  it("rejects empty, too long, or whitespace-segment names", () => {
    expect(() => validatePath("projects", "")).toThrow(BadNameError);
    expect(() => validatePath("projects", "a".repeat(600) + ".retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", "a//b.retro")).toThrow(BadNameError);
  });

  it("rejects parent / current / dotfile segments", () => {
    expect(() => validatePath("projects", "../etc/passwd.retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", "./song.retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", "a/../b.retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", ".hidden.retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", "sub/.hidden.retro")).toThrow(
      BadNameError,
    );
  });

  it("rejects absolute paths, backslashes, NUL", () => {
    expect(() => validatePath("projects", "/etc/passwd.retro")).toThrow(
      BadNameError,
    );
    expect(() => validatePath("projects", "a\\b.retro")).toThrow(BadNameError);
    expect(() => validatePath("projects", "a\0b.retro")).toThrow(BadNameError);
  });

  it("rejects wrong or missing extension", () => {
    expect(() => validatePath("projects", "song.mod")).toThrow(BadNameError);
    expect(() => validatePath("samples", "kick.mp3")).toThrow(BadNameError);
    expect(() => validatePath("modules", "intro.retro")).toThrow(BadNameError);
    expect(() => validatePath("projects", "noext")).toThrow(BadNameError);
  });
});

describe("resolveSafePath", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await tempHarness();
  });
  afterEach(async () => {
    await rm(h.cfg.dataDir, { recursive: true, force: true });
  });

  it("returns absolute path under the resource subdir", () => {
    const path = resolveSafePath(h.scope, "projects", "song.retro");
    expect(path).toBe(resolve(h.scope.subdirs.projects, "song.retro"));
    expect(path.startsWith(h.scope.subdirs.projects + sep)).toBe(true);
  });

  it("returns absolute path under nested subdirs", () => {
    const path = resolveSafePath(h.scope, "samples", "drums/kick.wav");
    expect(path).toBe(resolve(h.scope.subdirs.samples, "drums", "kick.wav"));
  });
});

describe("storage CRUD", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await tempHarness();
    await ensureDirs(h.scope);
  });
  afterEach(async () => {
    await rm(h.cfg.dataDir, { recursive: true, force: true });
  });

  it("write → read round-trips bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await writeFile(h.scope, "samples", "kick.wav", bytes);
    const out = await readFile(h.scope, "samples", "kick.wav");
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("write creates parent directories", async () => {
    const bytes = new Uint8Array([9]);
    await writeFile(h.scope, "samples", "drums/kicks/short.wav", bytes);
    const out = await readFile(h.scope, "samples", "drums/kicks/short.wav");
    expect(out[0]).toBe(9);
  });

  it("write overwrites existing files", async () => {
    await writeFile(h.scope, "samples", "k.wav", new Uint8Array([1]));
    await writeFile(h.scope, "samples", "k.wav", new Uint8Array([2, 2]));
    const out = await readFile(h.scope, "samples", "k.wav");
    expect(Array.from(out)).toEqual([2, 2]);
  });

  it("list returns recursive entries sorted by mtime desc", async () => {
    await writeFile(h.scope, "samples", "old.wav", new Uint8Array([1]));
    await fs.utimes(
      resolve(h.scope.subdirs.samples, "old.wav"),
      new Date(2000, 0, 1),
      new Date(2000, 0, 1),
    );
    await writeFile(h.scope, "samples", "sub/newer.wav", new Uint8Array([2]));
    const { entries, truncated } = await listDir(h.scope, "samples");
    expect(entries.map((e) => e.name)).toEqual(["sub/newer.wav", "old.wav"]);
    expect(entries[0]!.size).toBe(1);
    expect(truncated).toBe(false);
  });

  it("list skips wrong-extension and dotfiles", async () => {
    await writeFile(h.scope, "samples", "ok.wav", new Uint8Array([1]));
    // Drop bogus files directly with fs to bypass validation.
    await fs.writeFile(resolve(h.scope.subdirs.samples, "bad.mp3"), "x");
    await fs.writeFile(resolve(h.scope.subdirs.samples, ".hidden.wav"), "x");
    const { entries } = await listDir(h.scope, "samples");
    expect(entries.map((e) => e.name)).toEqual(["ok.wav"]);
  });

  it("list returns empty when dir does not exist", async () => {
    await rm(h.scope.subdirs.modules, { recursive: true, force: true });
    const { entries, truncated } = await listDir(h.scope, "modules");
    expect(entries).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("list truncates when the tree is deeper than MAX_LIST_DEPTH", async () => {
    // 10 nested dirs > the depth cap of 8. The deepest file should be
    // skipped and `truncated` should flip true.
    const deep = "a/b/c/d/e/f/g/h/i/buried.wav";
    await writeFile(h.scope, "samples", deep, new Uint8Array([1]));
    const { entries, truncated } = await listDir(h.scope, "samples");
    expect(truncated).toBe(true);
    expect(entries.map((e) => e.name)).not.toContain(deep);
  });

  it("list skips symbolic links (no escape via dangling symlinks)", async () => {
    await writeFile(h.scope, "samples", "real.wav", new Uint8Array([1]));
    // Point a symlink at /etc/passwd; listDir should silently skip it.
    await fs.symlink(
      "/etc/passwd",
      resolve(h.scope.subdirs.samples, "escape.wav"),
    );
    const { entries } = await listDir(h.scope, "samples");
    expect(entries.map((e) => e.name)).toEqual(["real.wav"]);
  });

  it("read of missing file throws NotFoundError", async () => {
    await expect(
      readFile(h.scope, "projects", "nope.retro"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("delete removes the file and prunes empty parents", async () => {
    await writeFile(h.scope, "samples", "a/b/c.wav", new Uint8Array([1]));
    await deleteFile(h.scope, "samples", "a/b/c.wav");
    await expect(
      readFile(h.scope, "samples", "a/b/c.wav"),
    ).rejects.toBeInstanceOf(NotFoundError);
    // a/ and a/b/ should be gone, but the resource root must remain.
    await expect(
      fs.stat(resolve(h.scope.subdirs.samples, "a")),
    ).rejects.toThrow();
    await expect(fs.stat(h.scope.subdirs.samples)).resolves.toBeTruthy();
  });

  it("delete keeps non-empty parent dirs", async () => {
    await writeFile(h.scope, "samples", "a/b.wav", new Uint8Array([1]));
    await writeFile(h.scope, "samples", "a/c.wav", new Uint8Array([2]));
    await deleteFile(h.scope, "samples", "a/b.wav");
    await expect(
      fs.stat(resolve(h.scope.subdirs.samples, "a")),
    ).resolves.toBeTruthy();
  });

  it("delete of missing file throws NotFoundError", async () => {
    await expect(
      deleteFile(h.scope, "projects", "nope.retro"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("userScope", () => {
  it("anonymous mode lands at the flat data dir", () => {
    const cfg: BackendConfig = {
      enabled: true,
      dataDir: "/data",
      auth: null,
      userQuotaBytes: 0,
      db: null,
      shareUserCap: 0,
    };
    const scope = userScope(cfg, null);
    expect(scope.root).toBe("/data");
    expect(scope.subdirs.projects).toBe("/data/projects");
  });

  it("auth mode hashes the sub into a per-user dir", () => {
    const cfg: BackendConfig = {
      enabled: true,
      dataDir: "/data",
      auth: {
        issuer: "https://example.test",
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.test/cb",
        cookieSecret: new Uint8Array(32),
        postLogoutRedirect: "/",
      },
      userQuotaBytes: 0,
      db: null,
      shareUserCap: 0,
    };
    const scope = userScope(cfg, "user-123");
    const hash = hashUserId("user-123");
    expect(hash).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(scope.root).toBe(`/data/users/${hash}`);
    expect(scope.subdirs.samples).toBe(`/data/users/${hash}/samples`);
  });

  it("auth mode with null userId throws (programming error)", () => {
    const cfg: BackendConfig = {
      enabled: true,
      dataDir: "/data",
      auth: {
        issuer: "https://example.test",
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.test/cb",
        cookieSecret: new Uint8Array(32),
        postLogoutRedirect: "/",
      },
      userQuotaBytes: 0,
      db: null,
      shareUserCap: 0,
    };
    expect(() => userScope(cfg, null)).toThrow();
  });

  it("hashUserId is deterministic", () => {
    expect(hashUserId("foo")).toBe(hashUserId("foo"));
    expect(hashUserId("foo")).not.toBe(hashUserId("bar"));
  });
});
