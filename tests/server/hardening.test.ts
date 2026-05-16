import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ensureDirs,
  readFile,
  userScope,
  writeFile,
  type UserScope,
} from "../../server/storage.js";
import type { BackendConfig } from "../../server/config.js";
import { createApp } from "../../server/app.js";
import { _resetBuckets, rateLimit } from "../../server/rateLimit.js";
import { audit } from "../../server/audit.js";
import { Hono } from "hono";

interface Harness {
  cfg: BackendConfig;
  scope: UserScope;
}

async function tempHarness(): Promise<Harness> {
  const dir = await mkdtemp(resolve(tmpdir(), "rt-hardening-"));
  const cfg: BackendConfig = {
    enabled: true,
    dataDir: dir,
    auth: null,
    userQuotaBytes: 0,
  };
  const scope = userScope(cfg, null);
  await ensureDirs(scope);
  return { cfg, scope };
}

describe("atomic writeFile", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await tempHarness();
  });
  afterEach(async () => {
    await rm(h.cfg.dataDir, { recursive: true, force: true });
  });

  it("writes round-trip and leaves no .tmp artifacts in the dir", async () => {
    await writeFile(h.scope, "samples", "a.wav", new Uint8Array([1, 2, 3]));
    const back = await readFile(h.scope, "samples", "a.wav");
    expect(Array.from(back)).toEqual([1, 2, 3]);
    const entries = await fs.readdir(h.scope.subdirs.samples);
    expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
  });

  it("cleans up the .tmp file when the rename fails", async () => {
    // Make the resource dir read-only so rename throws EACCES. The tmp
    // write succeeds (it's a freshly-created child), the rename fails,
    // and our error path must unlink the tmp.
    const samplesDir = h.scope.subdirs.samples;
    // Pre-populate so the rename target is the existing path.
    await writeFile(h.scope, "samples", "k.wav", new Uint8Array([1]));
    await fs.chmod(samplesDir, 0o500);
    let threw = false;
    try {
      // Different bytes, same name — the rename targets the existing
      // file. With the dir read-only, rename can't replace the target.
      await writeFile(h.scope, "samples", "k.wav", new Uint8Array([2]));
    } catch {
      threw = true;
    }
    // Restore so afterEach can clean up.
    await fs.chmod(samplesDir, 0o700);
    expect(threw).toBe(true);
    const left = (await fs.readdir(samplesDir)).filter((n) =>
      n.endsWith(".tmp"),
    );
    expect(left).toEqual([]);
  });
});

describe("audit log", () => {
  let logs: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("emits a parseable JSON line under the [audit] prefix", () => {
    audit({ evt: "auth.login.start", ip: "1.2.3.4" });
    expect(logs).toHaveLength(1);
    const m = logs[0]!.match(/^\[audit\] (.+)$/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]!);
    expect(parsed.evt).toBe("auth.login.start");
    expect(parsed.ip).toBe("1.2.3.4");
    expect(typeof parsed.ts).toBe("string");
  });
});

describe("rateLimit middleware", () => {
  beforeEach(() => _resetBuckets());

  it("429s after the bucket is empty", async () => {
    const app = new Hono();
    app.use(
      "/limited",
      rateLimit({ scope: "test", capacity: 3, refillPerSec: 0 }),
    );
    app.get("/limited", (c) => c.text("ok"));

    const headers = { "x-real-ip": "9.9.9.9" };
    for (let i = 0; i < 3; i++) {
      const ok = await app.request("/limited", { headers });
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request("/limited", { headers });
    expect(blocked.status).toBe(429);
  });

  it("buckets are per-IP — a different client isn't penalised", async () => {
    const app = new Hono();
    app.use(
      "/limited",
      rateLimit({ scope: "test", capacity: 1, refillPerSec: 0 }),
    );
    app.get("/limited", (c) => c.text("ok"));

    const a = await app.request("/limited", {
      headers: { "x-real-ip": "1.1.1.1" },
    });
    const b = await app.request("/limited", {
      headers: { "x-real-ip": "1.1.1.1" },
    });
    const c = await app.request("/limited", {
      headers: { "x-real-ip": "2.2.2.2" },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(429);
    expect(c.status).toBe(200);
  });
});

describe("audit emission on file.delete", () => {
  let logs: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;
  let harness: Harness;
  beforeEach(async () => {
    harness = await tempHarness();
    logs = [];
    spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
  });
  afterEach(async () => {
    spy.mockRestore();
    await rm(harness.cfg.dataDir, { recursive: true, force: true });
  });

  it("logs a file.delete event when a DELETE succeeds", async () => {
    const app = createApp({ cfg: harness.cfg, version: "t" });
    // PUT then DELETE the same file (anonymous mode → no Origin guard).
    await app.request("/api/samples/k.wav", {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    await app.request("/api/samples/k.wav", { method: "DELETE" });
    const auditLines = logs.filter((l) => l.startsWith("[audit] "));
    expect(auditLines).toHaveLength(1);
    const parsed = JSON.parse(auditLines[0]!.replace("[audit] ", ""));
    expect(parsed).toMatchObject({
      evt: "file.delete",
      resource: "samples",
      name: "k.wav",
      userHash: null,
    });
  });
});
