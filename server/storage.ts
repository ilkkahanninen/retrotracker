import { promises as fs } from "node:fs";
import { resolve, sep, extname, dirname, posix } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  RESOURCE_EXTENSIONS,
  RESOURCES,
  type BackendConfig,
  type Resource,
} from "./config.js";

export interface FileEntry {
  /** Slash-separated path relative to the resource root. */
  name: string;
  size: number;
  mtime: number;
}

/**
 * Filesystem scope for a single request. `root` is the user-or-anonymous
 * data root; `subdirs[r]` is the resource bucket inside it. Built per
 * request by `userScope(cfg, userId | null)` — the storage layer never
 * sees the config directly so it can't accidentally fall back to the
 * anonymous bucket while auth is on.
 */
export interface UserScope {
  root: string;
  subdirs: Record<Resource, string>;
}

export class BadNameError extends Error {
  override readonly name = "BadNameError";
}
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

const MAX_PATH_LEN = 500;
const MAX_SEGMENT_LEN = 200;

/**
 * Caps on the recursive listing. A malicious or runaway user can't
 * force the server to walk an unbounded tree — the walk halts at
 * either limit and the response gets `truncated: true`. Generous
 * enough that legitimate libraries won't notice.
 */
const MAX_LIST_DEPTH = 8;
const MAX_LIST_ENTRIES = 10_000;

/**
 * Build the per-request scope. When auth is enabled, `userId` is the
 * verified OIDC `sub` and gets hashed before it lands on disk (no PII
 * exposure, no need to defend against weird sub formats containing
 * slashes/dots). When auth is disabled, `userId` must be `null` and
 * paths live at the legacy flat root.
 *
 * Throws if auth is enabled but no user is provided — that's a coding
 * mistake (the route should have already returned 401).
 */
export function userScope(
  cfg: BackendConfig,
  userId: string | null,
): UserScope {
  if (cfg.auth && userId === null) {
    throw new Error(
      "[retrotracker] userScope: auth is enabled but no userId — route is leaking past requireUser",
    );
  }
  const root = cfg.auth
    ? resolve(cfg.dataDir, "users", hashUserId(userId!))
    : cfg.dataDir;
  return {
    root,
    subdirs: {
      projects: resolve(root, "projects"),
      samples: resolve(root, "samples"),
      modules: resolve(root, "modules"),
    },
  };
}

/**
 * Hash the OIDC `sub` into a fixed-format filesystem-safe directory
 * name. SHA-256 → base64url → first 32 chars. Deterministic, no PII
 * on disk, no escapable characters.
 */
export function hashUserId(sub: string): string {
  const digest = createHash("sha256").update(sub, "utf8").digest();
  return digest
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 32);
}

/**
 * Validate a slash-separated relative path. Names may contain subdirs
 * (e.g. `demos/2026/intro.retro`) but every segment must be a plain
 * filename — no `.`, `..`, empty, dotfile, backslash, NUL, or weird
 * length. The final segment's extension must match the resource.
 */
export function validatePath(resource: Resource, name: string): void {
  if (name.length === 0 || name.length > MAX_PATH_LEN) {
    throw new BadNameError("path length out of range");
  }
  if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
    throw new BadNameError("path contains forbidden characters");
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > MAX_SEGMENT_LEN) {
      throw new BadNameError("segment length out of range");
    }
    if (seg === "." || seg === "..") {
      throw new BadNameError("path contains . or ..");
    }
    if (seg.startsWith(".")) {
      throw new BadNameError("segment starts with dot");
    }
  }
  const leaf = segments[segments.length - 1]!;
  const ext = extname(leaf).toLowerCase();
  const allowed = RESOURCE_EXTENSIONS[resource];
  if (!allowed.includes(ext)) {
    throw new BadNameError(
      `expected one of ${allowed.join(", ")}, got "${ext}"`,
    );
  }
}

/**
 * Resolve a relative slash-path to an absolute path under the resource
 * subdir. Double-checks the result still lies under the subdir — defence
 * in depth on top of `validatePath`.
 */
export function resolveSafePath(
  scope: UserScope,
  resource: Resource,
  name: string,
): string {
  validatePath(resource, name);
  const root = scope.subdirs[resource];
  const full = resolve(root, name);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new BadNameError("resolved path escapes resource dir");
  }
  return full;
}

/** Ensure every resource subdir exists. Safe to call repeatedly. */
export async function ensureDirs(scope: UserScope): Promise<void> {
  for (const r of RESOURCES) {
    await fs.mkdir(scope.subdirs[r], { recursive: true });
  }
}

/**
 * Total bytes-on-disk used by all of a scope's resource buckets.
 * Walks the file tree directly (single pass per bucket, capped by the
 * same `MAX_LIST_*` limits as `listDir`) so we don't store a separate
 * running counter we'd have to keep in sync. Cheap for the file counts
 * a single user accumulates in practice.
 */
export async function scopeUsage(scope: UserScope): Promise<number> {
  let total = 0;
  for (const r of RESOURCES) {
    const { entries } = await listDir(scope, r);
    for (const e of entries) total += e.size;
  }
  return total;
}

/**
 * Stat a single file without throwing if it's missing. Returns the
 * byte length on disk or 0. Used by the quota check to compute "what
 * would the total be after this overwrite?" — the existing file's
 * bytes are subtracted first.
 */
export async function existingSize(
  scope: UserScope,
  resource: Resource,
  name: string,
): Promise<number> {
  try {
    const path = resolveSafePath(scope, resource, name);
    const st = await fs.lstat(path);
    if (st.isFile()) return st.size;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Per-user session revocation floor. Stored as a dotfile at the scope
 * root so it lives outside any resource bucket and is never reachable
 * via the API (resource listings skip dotfiles; the file isn't under
 * `subdirs[r]` anyway). Reading returns 0 when the file is absent or
 * unreadable — i.e. "never revoked".
 */
function sessionFloorPath(scope: UserScope): string {
  return resolve(scope.root, ".session-floor");
}

export async function readSessionFloor(scope: UserScope): Promise<number> {
  try {
    const buf = await fs.readFile(sessionFloorPath(scope), "utf8");
    const n = Number(buf.trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function writeSessionFloor(
  scope: UserScope,
  unixSeconds: number,
): Promise<void> {
  await fs.mkdir(scope.root, { recursive: true });
  await fs.writeFile(sessionFloorPath(scope), String(unixSeconds));
}

/**
 * Boot-time directory setup. Anonymous mode pre-creates the three flat
 * subdirs so an empty data dir works on first hit. Auth mode just makes
 * sure `<dataDir>/users` exists — per-user dirs get created lazily on
 * the first write.
 */
export async function ensureBaseDirs(cfg: BackendConfig): Promise<void> {
  if (!cfg.auth) {
    await ensureDirs(userScope(cfg, null));
  } else {
    await fs.mkdir(resolve(cfg.dataDir, "users"), { recursive: true });
  }
}

export interface ListResult {
  entries: FileEntry[];
  /** True when the walk halted at one of the safety caps. */
  truncated: boolean;
}

/**
 * Recursively list files under the resource subdir. Returns entries
 * with slash-separated relative paths, sorted by mtime descending.
 * Hidden entries (segments starting with `.`) and wrong-extension files
 * are skipped.
 *
 * Safety caps: walks at most `MAX_LIST_DEPTH` deep and collects at most
 * `MAX_LIST_ENTRIES` files. Either cap flips `truncated: true`. This
 * bounds the CPU / I/O a single GET can consume.
 */
export async function listDir(
  scope: UserScope,
  resource: Resource,
): Promise<ListResult> {
  const root = scope.subdirs[resource];
  const allowed = RESOURCE_EXTENSIONS[resource];
  const out: FileEntry[] = [];
  let truncated = false;

  async function walk(
    absDir: string,
    rel: string,
    depth: number,
  ): Promise<void> {
    if (truncated) return;
    if (depth > MAX_LIST_DEPTH) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(absDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of entries) {
      if (truncated) return;
      if (name.startsWith(".")) continue;
      const abs = resolve(absDir, name);
      const relPath = rel === "" ? name : posix.join(rel, name);
      let st;
      try {
        st = await fs.lstat(abs);
      } catch {
        continue;
      }
      // Symlinks are silently skipped — we never write them via the
      // API, and following one could escape the user's scope.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(abs, relPath, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (!allowed.includes(extname(name).toLowerCase())) continue;
      if (out.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      out.push({ name: relPath, size: st.size, mtime: st.mtimeMs });
    }
  }

  await walk(root, "", 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return { entries: out, truncated };
}

export async function readFile(
  scope: UserScope,
  resource: Resource,
  name: string,
): Promise<Uint8Array> {
  const path = resolveSafePath(scope, resource, name);
  try {
    const buf = await fs.readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(name);
    }
    throw e;
  }
}

/**
 * Atomic write: stream `bytes` to `<path>.<rand>.tmp`, then `rename()`
 * over the target. POSIX guarantees rename is atomic within a single
 * filesystem, so concurrent PUTs to the same name resolve cleanly
 * (one wins, the other's bytes are intact in the briefly-named tmp
 * file until rename overwrites them) and a crash mid-write never
 * leaves a half-truncated target. Listings filter by extension so the
 * tmp suffix keeps the in-flight bytes invisible.
 *
 * Overwrites silently — the UI is responsible for confirming with the
 * user before issuing a PUT against an existing name.
 */
export async function writeFile(
  scope: UserScope,
  resource: Resource,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = resolveSafePath(scope, resource, name);
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path);
  } catch (e) {
    // Best-effort cleanup; ignore if the tmp file is already gone.
    try {
      await fs.unlink(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
}

/**
 * Delete the file, then walk up its parent directories removing any
 * that became empty as a result. Stops at the resource root.
 */
export async function deleteFile(
  scope: UserScope,
  resource: Resource,
  name: string,
): Promise<void> {
  const root = scope.subdirs[resource];
  const path = resolveSafePath(scope, resource, name);
  try {
    await fs.unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(name);
    }
    throw e;
  }
  let parent = dirname(path);
  while (parent !== root && parent.startsWith(root + sep)) {
    try {
      await fs.rmdir(parent);
    } catch {
      break;
    }
    parent = dirname(parent);
  }
}
