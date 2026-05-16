import type { Connect, Plugin, ViteDevServer } from "vite";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { ensureDirs } from "./storage.js";

/**
 * Vite plugin that mounts the Hono backend as dev-server middleware. The
 * backend is force-enabled in `vite dev` so `npm run dev` is one command,
 * one port. Routes hot-reload along with the rest of the server because
 * the plugin re-imports config each call; the Hono app itself is built
 * once on `configureServer` (route table is stable).
 *
 * In `vite build` the plugin is a no-op — production wiring lives in
 * `server/index.ts`.
 */
export function backendPlugin(version: string): Plugin {
  return {
    name: "retrotracker-backend",
    apply: "serve",
    async configureServer(server: ViteDevServer) {
      const cfg = readConfig("dev");
      await ensureDirs(cfg);
      const app = createApp({ cfg, version });

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api")) return next();
        void honoHandle(app.fetch, req, res).catch(next);
      };
      server.middlewares.use(handler);

      // eslint-disable-next-line no-console
      console.log(`[retrotracker] backend dev API → ${cfg.dataDir}`);
    },
  };
}

/**
 * Adapt a Node IncomingMessage/ServerResponse pair to Hono's web-standard
 * fetch handler. We collect the request body up-front (the only callers
 * are PUT requests of moderate-size project / sample files; streaming
 * would add complexity for no real-world payoff).
 */
async function honoHandle(
  fetch: (req: Request) => Response | Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, v);
  }

  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = await readBody(req);
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    init.body = ab;
  }

  const response = await fetch(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    const stream = Readable.fromWeb(response.body as never);
    stream.pipe(res);
  } else {
    res.end();
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
