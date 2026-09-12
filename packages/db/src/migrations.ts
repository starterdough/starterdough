import { sql } from 'drizzle-orm';
import journal from '../drizzle/meta/_journal.json';
import { db, pg } from './client';

export interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

export interface MigrationStatus {
	/** Migrations the running code ships (`packages/db/drizzle`). */
	shipped: number;
	applied: number;
	/** Tags shipped with this build but not yet applied to the database. */
	pending: string[];
	/** Rows in the database no shipped migration accounts for (a newer build ran here). */
	unknown: number;
	latestApplied: string | null;
}

/**
 * Drizzle's migrator records each applied migration with `created_at` = the journal's `when`,
 * so the two can be diffed without hashing files at runtime. Pure: unit-tested.
 */
export function diffMigrations(entries: JournalEntry[], appliedWhen: number[]): MigrationStatus {
	const applied = new Set(appliedWhen);
	const shippedWhen = new Set(entries.map((e) => e.when));
	const pending = entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
	const latest = entries.filter((e) => applied.has(e.when)).sort((a, b) => b.idx - a.idx)[0];
	return {
		shipped: entries.length,
		applied: appliedWhen.length,
		pending,
		unknown: appliedWhen.filter((when) => !shippedWhen.has(when)).length,
		latestApplied: latest?.tag ?? null,
	};
}

export const shippedMigrations: JournalEntry[] = journal.entries.map(({ idx, when, tag }) => ({
	idx,
	when,
	tag,
}));

export async function migrationStatus(): Promise<MigrationStatus> {
	const rows = await db.execute<{ created_at: string | number }>(
		sql`select created_at from drizzle.__drizzle_migrations`,
	);
	return diffMigrations(
		shippedMigrations,
		rows.map((row) => Number(row.created_at)),
	);
}

/**
 * Round-trip latency to Postgres in milliseconds; throws when the database is unreachable.
 *
 * `statementTimeoutMs` bounds the query server-side, so a caller that stops waiting (a readiness
 * probe against a hung database) does not leave it running on a pooled connection. `SET LOCAL`
 * needs a transaction, and a parameter cannot appear in `SET`, hence `set_config(…, local = true)`.
 * Unbounded otherwise: a plain `select 1` is what the admin page's latency reading measures (a
 * transaction would add three round trips to it).
 */
export async function pingDatabase(statementTimeoutMs?: number): Promise<number> {
	const started = performance.now();
	if (statementTimeoutMs === undefined) {
		await db.execute(sql`select 1`);
	} else {
		await pg.begin(async (tx) => {
			await tx`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
			await tx`select 1`;
		});
	}
	return Math.round(performance.now() - started);
}
