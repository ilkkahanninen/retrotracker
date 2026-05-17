import { randomBytes } from "node:crypto";
import type { Pool } from "./db/pool.js";

/**
 * Resource buckets a share link may point at. Samples are deliberately
 * excluded — the share UX is "share a song", and `.wav` standalone
 * downloads don't fit that affordance. The CHECK constraint in
 * `migrate.ts` mirrors this list.
 */
export type ShareResource = "projects" | "modules";

export interface ShareRow {
  token: string;
  ownerSub: string;
  resource: ShareResource;
  name: string;
  createdAt: Date;
}

/**
 * Generate a URL-safe share token. 16 random bytes → base64url ≈ 22
 * chars. 128 bits is comfortably above any sane brute-force budget — a
 * leaked-token risk dominates this design, not enumeration. Token
 * grammar (regex `/^[A-Za-z0-9_-]{16,64}$/`) is validated in the route
 * before the DB lookup so malformed paths never hit the pool.
 *
 * NOTE on `=` padding: base64url encoding omits `=` (the trailing pad
 * is stripped). The resulting token has no characters outside
 * `[A-Za-z0-9_-]` and is exactly 22 chars for 16 bytes.
 */
export function mintToken(): string {
  return randomBytes(16).toString("base64url");
}

interface RawRow {
  token: string;
  owner_sub: string;
  resource: string;
  name: string;
  created_at: Date;
}

function toShareRow(r: RawRow): ShareRow {
  return {
    token: r.token,
    ownerSub: r.owner_sub,
    resource: r.resource as ShareResource,
    name: r.name,
    createdAt: r.created_at,
  };
}

/**
 * Idempotent create. If a row already exists for
 * `(owner_sub, resource, name)` we return it unchanged — the caller
 * sees `created: false` and the existing token is reused. This makes
 * the UI's "Share this song" button safe to click twice without
 * leaking duplicate live tokens the user has to track.
 *
 * Implemented as `INSERT … ON CONFLICT DO NOTHING RETURNING` followed
 * by a re-SELECT on conflict. We don't `UPDATE` on conflict because
 * the existing row's token is the one already shared.
 */
export async function createShare(
  pool: Pool,
  args: { ownerSub: string; resource: ShareResource; name: string },
): Promise<{ row: ShareRow; created: boolean }> {
  const token = mintToken();
  const insert = await pool.query<RawRow>(
    `INSERT INTO shares (token, owner_sub, resource, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_sub, resource, name) DO NOTHING
     RETURNING token, owner_sub, resource, name, created_at`,
    [token, args.ownerSub, args.resource, args.name],
  );
  if (insert.rowCount === 1) {
    return { row: toShareRow(insert.rows[0]!), created: true };
  }
  const existing = await pool.query<RawRow>(
    `SELECT token, owner_sub, resource, name, created_at
       FROM shares
      WHERE owner_sub = $1 AND resource = $2 AND name = $3`,
    [args.ownerSub, args.resource, args.name],
  );
  const r = existing.rows[0];
  if (!r) {
    throw new Error(
      "shares: upsert conflict resolved to no row — concurrent delete?",
    );
  }
  return { row: toShareRow(r), created: false };
}

/** Lookup by token. Returns null when the token doesn't exist. */
export async function getShareByToken(
  pool: Pool,
  token: string,
): Promise<ShareRow | null> {
  const res = await pool.query<RawRow>(
    `SELECT token, owner_sub, resource, name, created_at
       FROM shares
      WHERE token = $1`,
    [token],
  );
  const r = res.rows[0];
  return r ? toShareRow(r) : null;
}

/**
 * Delete by token, scoped to owner. Returns true when a row was
 * actually deleted — the route reports 404 for both unknown tokens
 * and tokens owned by someone else, so callers can't probe for token
 * existence.
 */
export async function deleteShareByOwner(
  pool: Pool,
  args: { ownerSub: string; token: string },
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM shares WHERE token = $1 AND owner_sub = $2`,
    [args.token, args.ownerSub],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listSharesByOwner(
  pool: Pool,
  ownerSub: string,
): Promise<ShareRow[]> {
  const res = await pool.query<RawRow>(
    `SELECT token, owner_sub, resource, name, created_at
       FROM shares
      WHERE owner_sub = $1
      ORDER BY created_at DESC`,
    [ownerSub],
  );
  return res.rows.map(toShareRow);
}

export async function countSharesByOwner(
  pool: Pool,
  ownerSub: string,
): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM shares WHERE owner_sub = $1`,
    [ownerSub],
  );
  return Number(res.rows[0]?.count ?? 0);
}
