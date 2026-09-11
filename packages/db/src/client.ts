import { env } from '@repo/env';
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import * as schema from './schema';

/**
 * Bun's built-in Postgres client — no `pg`/`postgres` npm driver needed.
 * The connection is opened lazily on first query.
 *
 * Only the API (Bun runtime) talks to the database. Frontends never import this
 * package; they go through the HTTP API (see README → "Single source of truth").
 *
 * Pool sizing: every process that loads this module (each API replica, each standalone worker)
 * may open up to `DATABASE_POOL_MAX` connections, and Postgres refuses anything beyond its
 * `max_connections` (100 by default). Keep
 *
 *   api replicas × pool + workers × pool + migrate (2: lock + migrator) + backup/pg_dump (1)
 *     + headroom for psql
 *
 * under that limit — or raise `max_connections` / put PgBouncer in front before scaling out.
 * The default of 10 per process leaves plenty of room for the compose setup (one api, one worker).
 */
const poolMax = env.DATABASE_POOL_MAX;

// `bun --hot` re-evaluates this module and would open a fresh pool each time, never closing the
// previous one: keep the single pool on `globalThis` (same slot trick as the API's worker and
// telemetry). Changing `DATABASE_URL` / `DATABASE_POOL_MAX` therefore needs a real restart.
const POOL = Symbol.for('starterdough.db.pool');
const g = globalThis as typeof globalThis & { [POOL]?: SQL };
// `connectionTimeout` (seconds) bounds a hung connect: the shared `/readyz` ping only settles
// when the connect attempt gives up, so this is how long readiness can lag a recovering server.
g[POOL] ??= new SQL(env.DATABASE_URL, { max: poolMax, connectionTimeout: 10 });
export const pg: SQL = g[POOL];

export const db = drizzle({ client: pg, schema, casing: 'snake_case' });

export type Database = typeof db;

/** An open transaction: the same query surface as `db`, pinned to one connection. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Whatever a query helper should run on — the pool, or a caller's open transaction. Helpers that a
 * check-then-write sequence needs to see consistently take one of these (`executor ?? db`), so the
 * count and the insert can both happen inside `withOrganizationLock`.
 */
export type Executor = Database | DbTransaction;
