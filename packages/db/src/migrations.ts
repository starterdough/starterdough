import { join } from 'node:path';
import type { SQL } from 'bun';
import { sql } from 'drizzle-orm';
import kitJournal from '../drizzle/meta/_journal.json';
import productJournal from '../drizzle-product/meta/_journal.json';
import { db, pg } from './client';

export interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

export interface MigrationStatus {
	/** Migrations the running code ships for this history. */
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

/**
 * The two migration histories, applied in this order. The kit's (`packages/db/drizzle`) is written
 * only by kit releases; the product's (`packages/db/drizzle-product`) only by `bun run db:generate`
 * in a product. Each is a plain Drizzle history with a table of its own, so a kit release that adds
 * a migration never interleaves with a product's, and Drizzle's "newer than the newest applied"
 * rule only ever compares migrations by one author.
 */
export interface MigrationHistory {
	name: 'kit' | 'product';
	folder: string;
	/** Drizzle's `migrationsSchema` and `migrationsTable`. */
	schema: 'drizzle';
	table: string;
	entries: JournalEntry[];
}

/** An empty journal's `entries` is typed `never[]`, so both go through this. */
function entriesOf(journal: { entries: readonly JournalEntry[] }): JournalEntry[] {
	return journal.entries.map(({ idx, when, tag }) => ({ idx, when, tag }));
}

export const kitMigrations: MigrationHistory = {
	name: 'kit',
	folder: join(import.meta.dir, '../drizzle'),
	schema: 'drizzle',
	table: '__drizzle_migrations',
	entries: entriesOf(kitJournal),
};

export const productMigrations: MigrationHistory = {
	name: 'product',
	folder: join(import.meta.dir, '../drizzle-product'),
	schema: 'drizzle',
	table: '__product_migrations',
	entries: entriesOf(productJournal),
};

async function appliedWhen(history: MigrationHistory): Promise<number[]> {
	// Drizzle creates each table on its first run, so until then nothing of that history is applied:
	// the product table appears with the first 1.1.0 `db:migrate`.
	const [table] = await db.execute<{ present: boolean }>(
		sql`select to_regclass(${`${history.schema}.${history.table}`}) is not null as present`,
	);
	if (!table?.present) return [];
	const rows = await db.execute<{ created_at: string | number }>(
		sql`select created_at from ${sql.identifier(history.schema)}.${sql.identifier(history.table)}`,
	);
	return rows.map((row) => Number(row.created_at));
}

export async function migrationStatus(): Promise<{
	kit: MigrationStatus;
	product: MigrationStatus;
}> {
	const status = async (history: MigrationHistory) =>
		diffMigrations(history.entries, await appliedWhen(history));
	const [kit, product] = await Promise.all([status(kitMigrations), status(productMigrations)]);
	return { kit, product };
}

/**
 * Before 1.1.0 a product's migrations sat in the kit's history: `db:generate` wrote them to
 * `packages/db/drizzle`, and `db:migrate` recorded them in `drizzle.__drizzle_migrations`.
 * `bun run db:move-product-migrations` moves the files to `drizzle-product/` with their journal
 * `when` kept, but a database that ran them still has their rows in the kit's table, where they
 * would make Drizzle skip every kit migration older than them. This moves those rows to the
 * product's table, in one transaction, before either history runs: a row moves when its
 * `created_at` is a product journal `when`. A database with no such row (every database that only
 * ever ran kit migrations, fresh or not) is left alone, and a second run moves nothing. Returns how
 * many rows moved.
 */
export async function rehomeProductMigrations(
	client: SQL,
	kit: readonly JournalEntry[] = kitMigrations.entries,
	product: readonly JournalEntry[] = productMigrations.entries,
): Promise<number> {
	const kitWhen = new Set(kit.map((entry) => entry.when));
	const shared = product.filter((entry) => kitWhen.has(entry.when));
	if (shared.length > 0) {
		throw new Error(
			`${shared.map((entry) => entry.tag).join(', ')} in packages/db/drizzle-product has the timestamp of a kit migration, so neither history could tell which one a database ran. A migration lives in one history only: generate it again with \`bun run db:generate\`.`,
		);
	}
	if (product.length === 0) return 0;
	const [{ present }] =
		await client`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
	if (!present) return 0;
	const productWhen = product.map((entry) => entry.when);
	return client.begin(async (tx) => {
		// Drizzle's own definition of its table, so its migrator takes this one over unchanged.
		await tx`create table if not exists drizzle.__product_migrations (id serial primary key, hash text not null, created_at bigint)`;
		const moved: Array<{ hash: string; created_at: string }> = await tx`
			delete from drizzle.__drizzle_migrations
			where created_at in ${tx(productWhen)}
			returning hash, created_at`;
		for (const row of moved) {
			await tx`
				insert into drizzle.__product_migrations (hash, created_at)
				select ${row.hash}, ${row.created_at}
				where not exists (
					select 1 from drizzle.__product_migrations where created_at = ${row.created_at}
				)`;
		}
		return moved.length;
	});
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
