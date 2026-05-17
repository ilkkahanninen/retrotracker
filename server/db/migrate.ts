import type { Pool } from "./pool.js";

/**
 * Schema bootstrap for the share-link feature. Idempotent — safe to call
 * on every boot. Run from `server/index.ts` `main()` (and the vite dev
 * plugin) before `createApp`. A connect failure here refuses to start,
 * mirroring `assertSecureIssuer`: an operator who set `DATABASE_URL`
 * expects shares to work, so failing loud beats degrading silently.
 *
 * Schema (revoke-only, no expiry):
 *   - `token`     — PK, the random string handed out in `/share/<token>`.
 *   - `owner_sub` — raw OIDC sub of the creator. We need the raw value
 *                   to rebuild the owner's `UserScope` (which re-hashes
 *                   internally) when reading their file for a public
 *                   share GET. PII at rest, no worse than what an OIDC
 *                   ID-token cache would hold.
 *   - `resource`  — `projects` or `modules`. Samples are not shareable.
 *   - `name`      — slash path relative to the bucket. Validated by
 *                   `validatePath` before INSERT.
 *   - `created_at`— audit metadata; surfaced in the "Your shares" UI.
 *
 * The unique `(owner_sub, resource, name)` index makes share creation
 * idempotent: a second "Share" click on the same song returns the
 * existing token rather than minting another one.
 */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(SQL);
}

const SQL = `
CREATE TABLE IF NOT EXISTS shares (
  token       TEXT PRIMARY KEY,
  owner_sub   TEXT NOT NULL,
  resource    TEXT NOT NULL CHECK (resource IN ('projects','modules')),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_owner_idx
  ON shares (owner_sub, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS shares_owner_resource_name_uniq
  ON shares (owner_sub, resource, name);
`;
