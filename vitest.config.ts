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
    // Polyfills jsdom's missing Blob/File arrayBuffer/text. Self-guards
    // against missing globals so node-env suites import it as a no-op.
    setupFiles: ["tests/ui/setup.ts"],
    testTimeout: 30_000,
    // Per-directory environment: anything under `tests/ui/` runs in jsdom so
    // we can mount Solid components and dispatch keyboard events. The
    // accuracy / replayer / parser tests keep the lighter node environment.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/ui/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
