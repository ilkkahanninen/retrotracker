import { resolve } from "node:path";

/**
 * Resource buckets exposed by the API. Each maps to a subdirectory under
 * the configured data dir and is restricted to a set of file extensions
 * by the storage layer.
 */
export type Resource = "projects" | "samples" | "modules";

export const RESOURCE_EXTENSIONS: Record<Resource, readonly string[]> = {
  projects: [".retro"],
  samples: [".wav"],
  modules: [".mod", ".xm"],
} as const;

export const RESOURCES: readonly Resource[] = [
  "projects",
  "samples",
  "modules",
] as const;

export interface BackendConfig {
  enabled: boolean;
  dataDir: string;
  subdirs: Record<Resource, string>;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.toLowerCase());
}

/**
 * Resolve runtime config from env. `mode` matters because dev forces the
 * backend on regardless of RETROTRACKER_BACKEND, while prod respects the
 * opt-in flag (default off, so CI-built images stay inert).
 *
 * Data layout under `dataDir`:
 *   <dataDir>/projects, <dataDir>/samples, <dataDir>/modules
 *
 * In a container we default `dataDir` to `/` so the three subdirs are at
 * `/projects`, `/samples`, `/modules` for direct volume mounting.
 */
export function readConfig(
  mode: "dev" | "prod",
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const enabled = mode === "dev" || isTruthy(env["RETROTRACKER_BACKEND"]);
  const defaultDir = mode === "dev" ? resolve(process.cwd(), "data") : "/";
  const dataDir = resolve(env["RETROTRACKER_DATA_DIR"] ?? defaultDir);
  const subdirs: Record<Resource, string> = {
    projects: resolve(dataDir, "projects"),
    samples: resolve(dataDir, "samples"),
    modules: resolve(dataDir, "modules"),
  };
  return { enabled, dataDir, subdirs };
}
