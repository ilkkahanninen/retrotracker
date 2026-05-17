import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { promises as fs, createReadStream, statSync } from "node:fs";
import { resolve, extname, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { ensureBaseDirs } from "./storage.js";
import { createPool, type Pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";

declare const __APP_VERSION__: string;
const VERSION =
  typeof __APP_VERSION__ === "string"
    ? __APP_VERSION__
    : (process.env["APP_VERSION"] ?? "dev");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function main(): Promise<void> {
  const cfg = readConfig("prod");
  const port = Number(process.env["PORT"] ?? 80);
  const distDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
  );

  let apiHandler:
    | ((req: IncomingMessage, res: ServerResponse) => Promise<void>)
    | null = null;
  if (cfg.enabled) {
    await ensureBaseDirs(cfg);
    // Pool + schema bootstrap fail loud — an operator who set
    // DATABASE_URL expects sharing to work; degrading silently would
    // be worse than refusing to start. The pool lives for the process
    // lifetime; no explicit `pool.end()` needed because Node exit
    // closes the underlying sockets and `pg` doesn't queue work.
    let pool: Pool | null = null;
    if (cfg.db) {
      pool = createPool(cfg.db.dsn);
      await migrate(pool);
    }
    const app = createApp({ cfg, version: VERSION, pool });
    apiHandler = (req, res) => honoHandle(app.fetch, req, res);
    // eslint-disable-next-line no-console
    console.log(
      `[retrotracker] backend ENABLED → ${cfg.dataDir} · shares ${
        pool ? "on" : "off"
      }`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[retrotracker] backend DISABLED (set RETROTRACKER_BACKEND=1 to enable)",
    );
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (apiHandler && url.startsWith("/api")) {
      void apiHandler(req, res).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[retrotracker] api error", e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
      return;
    }
    void serveStatic(distDir, req, res).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[retrotracker] static error", e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[retrotracker] listening on :${port}`);
  });
}

/**
 * Serve a file out of `distDir`. SPA fallback: 404s on file paths fall
 * through to `index.html` so client-side routing keeps working (matches
 * the previous nginx `try_files $uri $uri/ /index.html` behaviour).
 */
async function serveStatic(
  distDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reqUrl = (req.url ?? "/").split("?")[0]!;
  const decoded = decodeURIComponent(reqUrl);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const candidate = resolve(distDir, "." + rel);
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const path = await pickExisting(candidate, distDir);
  if (!path) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const ext = extname(path).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  applySecurityHeaders(res);
  if (
    path !== resolve(distDir, "index.html") &&
    path.includes(`${sep}assets${sep}`)
  ) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(path);
    stream.on("error", fail);
    stream.on("end", done);
    stream.pipe(res);
  });
}

/**
 * Baseline browser-side hardening for every static response.
 *
 * - `X-Frame-Options` + `frame-ancestors 'none'`: no embedding (clickjacking).
 * - `X-Content-Type-Options: nosniff`: kill MIME confusion.
 * - `Referrer-Policy`: don't leak deep-link URLs to third parties.
 * - CSP: same-origin everything plus the few escape hatches the tracker
 *   actually needs:
 *     - `'wasm-unsafe-eval'`: WebAudio + bundled wasm tables.
 *     - `style-src 'unsafe-inline'`: Solid emits a few inline styles.
 *     - `worker-src/media-src/img-src blob:`: AudioWorklet + sample preview.
 *     - `img-src data:`: SVG / favicons inlined by Vite.
 *     - `connect-src 'self'`: only our own /api endpoints.
 *     - `object-src 'none'`, `base-uri 'self'`: kill historical bypasses.
 *   Adjust if you add a CDN or an external image host (e.g. Logto avatars).
 */
function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

async function pickExisting(
  candidate: string,
  distDir: string,
): Promise<string | null> {
  try {
    const st = await fs.stat(candidate);
    if (st.isFile()) return candidate;
  } catch {
    // fall through to SPA fallback
  }
  const fallback = resolve(distDir, "index.html");
  try {
    statSync(fallback);
    return fallback;
  } catch {
    return null;
  }
}

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
  // See vitePlugin.ts for the same comment — always overwrite x-real-ip
  // from the socket so downstream middleware can't be fooled by an
  // attacker-supplied header.
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
  // Set-Cookie must be emitted as multiple separate header lines —
  // collapsing via Headers.forEach corrupts cookies whose grammar
  // already uses commas. Mirror the dev plugin's handling.
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

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[retrotracker] fatal", e);
  process.exit(1);
});
