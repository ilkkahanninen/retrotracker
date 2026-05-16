import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  BadNameError,
  NotFoundError,
  deleteFile,
  listDir,
  readFile,
  writeFile,
} from "./storage.js";
import {
  RESOURCES,
  RESOURCE_EXTENSIONS,
  type BackendConfig,
  type Resource,
} from "./config.js";

export interface AppDeps {
  cfg: BackendConfig;
  /** Version string surfaced by /api/health. */
  version: string;
}

const MIME: Record<Resource, string> = {
  projects: "application/json",
  samples: "audio/wav",
  modules: "application/octet-stream",
};

/**
 * Hono app exposing project / sample / module CRUD under /api. Caller is
 * responsible for only mounting this when `cfg.enabled` — the app itself
 * trusts that gate and serves every route unconditionally.
 *
 * Names may contain slashes to address files in subdirectories. The
 * storage layer validates each segment; bad input lands on a 400.
 */
export function createApp({ cfg, version }: AppDeps): Hono {
  const app = new Hono().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true, version }));

  for (const resource of RESOURCES) {
    const base = `/${resource}`;
    const mime = MIME[resource];

    app.get(base, async (c) => {
      const entries = await listDir(cfg, resource);
      return c.json({
        resource,
        extensions: RESOURCE_EXTENSIONS[resource],
        entries,
      });
    });

    app.get(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      try {
        const bytes = await readFile(cfg, resource, name);
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        return c.body(ab, 200, {
          "Content-Type": mime,
          "Content-Length": String(bytes.byteLength),
        });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });

    app.put(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      try {
        const buf = await c.req.arrayBuffer();
        await writeFile(cfg, resource, name, new Uint8Array(buf));
        return c.json({ ok: true, name });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });

    app.delete(`${base}/:name{.+}`, async (c) => {
      const name = c.req.param("name");
      try {
        await deleteFile(cfg, resource, name);
        return c.json({ ok: true, name });
      } catch (e) {
        const { status, body } = errorPayload(e);
        return c.json(body, status);
      }
    });
  }

  return app;
}

interface ErrorBody {
  error: string;
  message: string;
}

function errorPayload(e: unknown): {
  status: ContentfulStatusCode;
  body: ErrorBody;
} {
  if (e instanceof BadNameError) {
    return { status: 400, body: { error: "bad-name", message: e.message } };
  }
  if (e instanceof NotFoundError) {
    return { status: 404, body: { error: "not-found", message: e.message } };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { error: "internal", message } };
}
