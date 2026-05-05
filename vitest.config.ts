import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Per-file environment: anything under `tests/ui/` runs in jsdom so we
    // can mount Solid components and dispatch keyboard events. The accuracy
    // / replayer / parser tests keep the lighter node environment.
    environmentMatchGlobs: [["tests/ui/**", "jsdom"]],
    testTimeout: 30_000,
  },
});
