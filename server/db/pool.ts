import pg from "pg";

/**
 * Thin wrapper around `pg.Pool` so the rest of the server only depends
 * on a tiny `Pool` shape. One pool per app instance — created in the
 * entry point (`server/index.ts` for prod, `server/vitePlugin.ts` for
 * dev), threaded into `createApp({ ..., pool })`, and passed onward to
 * the share routes.
 *
 * No connection pre-warming, no health check on create — the first
 * query is what surfaces a bad DSN. Callers should run `migrate(pool)`
 * once at boot, which doubles as a connection probe.
 */
export type Pool = pg.Pool;

export function createPool(dsn: string): Pool {
  return new pg.Pool({ connectionString: dsn });
}
