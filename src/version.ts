/**
 * Build-time version string, injected by Vite's `define` from the output
 * of `scripts/version.sh` (latest tag + commit count since the tag, e.g.
 * `v0.2.3`). In tests / non-Vite contexts the global isn't defined, so
 * the file falls back to a stable placeholder rather than crashing.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
