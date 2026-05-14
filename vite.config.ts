import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * Resolves the build's version string from scripts/version.sh — the
 * single source of truth for "what version is this." Falls back to
 * "dev" if the script fails (no git, no tags, shallow clone in CI).
 *
 * Computed at config time so the result is baked into the bundle as a
 * literal via `define`, not re-evaluated at runtime.
 */
function readVersion(): string {
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
  plugins: [solid()],
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
