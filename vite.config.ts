import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { backendPlugin } from "./server/vitePlugin";

/**
 * Resolves the build's version string. Order of precedence:
 *
 *   1. `process.env.APP_VERSION` — set explicitly by the caller. The
 *      Docker image build uses this because `.dockerignore` strips
 *      `.git`, so the script can't run inside the container; CI
 *      computes the version once on the host and passes it through.
 *   2. `./scripts/version.sh` — the single source of truth otherwise
 *      (latest git tag + commits since, e.g. `v0.2.3`).
 *   3. `"dev"` — fallback when neither is available (shallow clone,
 *      no tags, missing git).
 *
 * Computed at config time so the result is baked into the bundle as a
 * literal via `define`, not re-evaluated at runtime.
 */
function readVersion(): string {
  const fromEnv = process.env["APP_VERSION"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    return execSync("./scripts/version.sh", {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
    }).trim();
  } catch {
    return "dev";
  }
}

const APP_VERSION = readVersion();

export default defineConfig({
  plugins: [solid(), backendPlugin(APP_VERSION)],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
