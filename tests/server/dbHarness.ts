import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "../../server/db/pool.js";
import { migrate } from "../../server/db/migrate.js";

/**
 * Per-test PG isolation. Each test gets a unique schema; the pool's
 * `search_path` is pinned to it so every query lands inside the
 * isolated namespace. `dropSchema` cleans up in `afterEach`.
 *
 * Tests gated on `TEST_DATABASE_URL` — when unset, the parent test
 * file should `describe.skip` itself. CI without a live PG stays green.
 *
 * Schema-isolation beats DB-per-test for speed: a docker postgres can
 * create a schema in a few ms but takes seconds for a fresh DB. Both
 * isolate the same way for our purposes (no cross-test pollution).
 */

export interface TestDb {
  pool: Pool;
  schema: string;
}

export async function makeIsolatedDb(dsn: string): Promise<TestDb> {
  // Use a fresh pool per test so each session can pin its own
  // `search_path` without leaking to siblings. Tearing down the pool
  // alongside the schema avoids stranded connections under repeated runs.
  const pool = createPool(dsn);
  const schema = `rt_test_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}`);
  await migrate(pool);
  return { pool, schema };
}

export async function teardownDb(db: TestDb): Promise<void> {
  try {
    await db.pool.query(`DROP SCHEMA ${db.schema} CASCADE`);
  } finally {
    await db.pool.end();
  }
}
