import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp, type AppType } from "../../server/app.js";
import { ensureDirs, userScope } from "../../server/storage.js";
import type { BackendConfig } from "../../server/config.js";

async function tempCfg(): Promise<BackendConfig> {
  const dir = await mkdtemp(resolve(tmpdir(), "rt-backend-app-"));
  return { enabled: true, dataDir: dir, auth: null, userQuotaBytes: 0 };
}

interface Harness {
  cfg: BackendConfig;
  app: AppType;
}

async function setup(): Promise<Harness> {
  const cfg = await tempCfg();
  await ensureDirs(userScope(cfg, null));
  const app = createApp({ cfg, version: "test" });
  return { cfg, app };
}

describe("server/app", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await rm(h.cfg.dataDir, { recursive: true, force: true });
  });

  it("GET /api/health returns ok + version", async () => {
    const res = await h.app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "test" });
  });

  it("GET /api/projects returns empty listing on a fresh dir", async () => {
    const res = await h.app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      extensions: string[];
      entries: unknown[];
    };
    expect(body.resource).toBe("projects");
    expect(body.extensions).toEqual([".retro"]);
    expect(body.entries).toEqual([]);
  });

  it("PUT → GET round-trips bytes for each resource", async () => {
    const cases = [
      { url: "/api/projects/song.retro", bytes: new Uint8Array([1, 2, 3]) },
      { url: "/api/samples/kick.wav", bytes: new Uint8Array([4, 5, 6]) },
      { url: "/api/modules/intro.mod", bytes: new Uint8Array([7, 8, 9]) },
    ];
    for (const { url, bytes } of cases) {
      const put = await h.app.request(url, { method: "PUT", body: bytes });
      expect(put.status).toBe(200);
      const get = await h.app.request(url);
      expect(get.status).toBe(200);
      const out = new Uint8Array(await get.arrayBuffer());
      expect(Array.from(out)).toEqual(Array.from(bytes));
    }
  });

  it("PUT into a nested path creates parent dirs", async () => {
    const bytes = new Uint8Array([42]);
    const put = await h.app.request("/api/samples/drums/kicks/short.wav", {
      method: "PUT",
      body: bytes,
    });
    expect(put.status).toBe(200);
    const list = (await (await h.app.request("/api/samples")).json()) as {
      entries: { name: string }[];
    };
    expect(list.entries.map((e) => e.name)).toContain("drums/kicks/short.wav");
  });

  it("DELETE removes a file", async () => {
    await h.app.request("/api/projects/a.retro", {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    const del = await h.app.request("/api/projects/a.retro", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const get = await h.app.request("/api/projects/a.retro");
    expect(get.status).toBe(404);
  });

  it("returns 400 on bad names", async () => {
    const cases = [
      "/api/projects/..%2Fetc%2Fpasswd.retro",
      "/api/projects/song.mod", // wrong extension
      "/api/samples/.hidden.wav",
    ];
    for (const url of cases) {
      const res = await h.app.request(url, {
        method: "PUT",
        body: new Uint8Array([1]),
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns 404 on missing GET", async () => {
    const res = await h.app.request("/api/projects/missing.retro");
    expect(res.status).toBe(404);
  });

  it("returns 404 on DELETE of missing file", async () => {
    const res = await h.app.request("/api/projects/missing.retro", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("listing reports correct extensions for each resource", async () => {
    const projects = (await (await h.app.request("/api/projects")).json()) as {
      extensions: string[];
    };
    const samples = (await (await h.app.request("/api/samples")).json()) as {
      extensions: string[];
    };
    const modules = (await (await h.app.request("/api/modules")).json()) as {
      extensions: string[];
    };
    expect(projects.extensions).toEqual([".retro"]);
    expect(samples.extensions).toEqual([".wav"]);
    expect(modules.extensions).toEqual([".mod", ".xm"]);
  });
});
