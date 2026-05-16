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
import { ensureDirs } from "./storage.js";

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
    await ensureDirs(cfg);
    const app = createApp({ cfg, version: VERSION });
    apiHandler = (req, res) => honoHandle(app.fetch, req, res);
    // eslint-disable-next-line no-console
    console.log(`[retrotracker] backend ENABLED → ${cfg.dataDir}`);
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

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[retrotracker] fatal", e);
  process.exit(1);
});
