import type { Connect, Plugin, ViteDevServer } from "vite";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { ensureBaseDirs } from "./storage.js";
import { createPool, type Pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";

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
      await ensureBaseDirs(cfg);
      // Same posture as prod: pool + migration fail loud. Dev devs who
      // haven't set DATABASE_URL just won't get the share UI.
      let pool: Pool | null = null;
      if (cfg.db) {
        pool = createPool(cfg.db.dsn);
        await migrate(pool);
      }
      const app = createApp({ cfg, version, pool });

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api")) return next();
        void honoHandle(app.fetch, req, res).catch(next);
      };
      server.middlewares.use(handler);

      const authNote = cfg.auth
        ? `auth on (issuer ${cfg.auth.issuer})`
        : "anonymous (no OIDC)";
      // eslint-disable-next-line no-console
      console.log(
        `[retrotracker] backend dev API → ${cfg.dataDir} · ${authNote} · shares ${
          pool ? "on" : "off"
        }`,
      );
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
  // Inject the socket's remote address so downstream middleware (rate
  // limiter, audit log) can scope per client. Always overwrite — never
  // trust an externally-supplied x-real-ip. If we're behind a reverse
  // proxy, this captures the proxy IP and the operator should adjust
  // rate limits accordingly (proper X-Forwarded-For trust is a future
  // env-var-gated feature).
  const remote = req.socket.remoteAddress;
  if (remote) headers.set("x-real-ip", remote);

  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = await readBody(req);
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    init.body = ab;
  }

  const response = await fetch(new Request(url, init));
  res.statusCode = response.status;
  // Web Headers.forEach collapses multi-valued headers into a single
  // comma-joined string. That's fine for most headers but breaks
  // Set-Cookie, whose grammar already uses commas (e.g. in `Expires`),
  // so a browser receiving "rt_state=a; Path=/, rt_nonce=b; Path=/"
  // parses it as one mangled cookie and drops the rest. Emit Set-Cookie
  // as a real array via getSetCookie() and skip it in the forEach.
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);
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
