import { promises as fs } from "node:fs";
import { resolve, sep, extname, dirname, posix } from "node:path";
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

export class BadNameError extends Error {
  override readonly name = "BadNameError";
}
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

const MAX_PATH_LEN = 500;
const MAX_SEGMENT_LEN = 200;

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
  cfg: BackendConfig,
  resource: Resource,
  name: string,
): string {
  validatePath(resource, name);
  const root = cfg.subdirs[resource];
  const full = resolve(root, name);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new BadNameError("resolved path escapes resource dir");
  }
  return full;
}

/** Ensure every resource subdir exists. Safe to call repeatedly. */
export async function ensureDirs(cfg: BackendConfig): Promise<void> {
  for (const r of RESOURCES) {
    await fs.mkdir(cfg.subdirs[r], { recursive: true });
  }
}

/**
 * Recursively list files under the resource subdir. Returns entries
 * with slash-separated relative paths, sorted by mtime descending.
 * Hidden entries (segments starting with `.`) and wrong-extension files
 * are skipped.
 */
export async function listDir(
  cfg: BackendConfig,
  resource: Resource,
): Promise<FileEntry[]> {
  const root = cfg.subdirs[resource];
  const allowed = RESOURCE_EXTENSIONS[resource];
  const out: FileEntry[] = [];

  async function walk(absDir: string, rel: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(absDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const abs = resolve(absDir, name);
      const relPath = rel === "" ? name : posix.join(rel, name);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      if (!allowed.includes(extname(name).toLowerCase())) continue;
      out.push({ name: relPath, size: st.size, mtime: st.mtimeMs });
    }
  }

  await walk(root, "");
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function readFile(
  cfg: BackendConfig,
  resource: Resource,
  name: string,
): Promise<Uint8Array> {
  const path = resolveSafePath(cfg, resource, name);
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
 * Write `bytes` to the resolved path, creating any intermediate subdirs.
 * Overwrites silently — the UI is responsible for confirming with the
 * user before issuing a PUT against an existing name.
 */
export async function writeFile(
  cfg: BackendConfig,
  resource: Resource,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = resolveSafePath(cfg, resource, name);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, bytes);
}

/**
 * Delete the file, then walk up its parent directories removing any
 * that became empty as a result. Stops at the resource root.
 */
export async function deleteFile(
  cfg: BackendConfig,
  resource: Resource,
  name: string,
): Promise<void> {
  const root = cfg.subdirs[resource];
  const path = resolveSafePath(cfg, resource, name);
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
