import { describe, expect, it } from 'bun:test';
import { is, Table } from 'drizzle-orm';
import { toSnakeCase } from 'drizzle-orm/casing';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/**
 * Every table and column the Drizzle schema declares, the kit's and yours, exists in the migrated
 * database. A column declared without a migration (a Better Auth plugin after `auth:schema`, a field
 * added to a table of yours without `db:generate`) typechecks and fails at its first query in
 * production. Runs against `DATABASE_URL` once `migrate.ts` has applied both histories, like the
 * other SQL tests here, and skips without it.
 */
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('the migrated database', () => {
	it('has every table and column the schema declares', async () => {
		process.env.SKIP_ENV_VALIDATION ??= '1';
		const { pg } = await import('./client');
		const kit = await import('./schema');
		const product = await import('./schema/product');
		// Widened first: once `schema/product.ts` exports a table, the union of both modules' export
		// types no longer admits `PgTable` as a narrowing, and `bun run check` fails here.
		const exported: unknown[] = [...Object.values(kit), ...Object.values(product)];
		const tables = exported.filter((value): value is PgTable => is(value, Table));
		expect(tables.length).toBeGreaterThan(0);
		const rows: Array<{ name: string }> = await pg`
			select table_schema || '.' || table_name || '.' || column_name as name
			from information_schema.columns
			where table_schema not in ('pg_catalog', 'information_schema')`;
		const present = new Set(rows.map((row) => row.name));
		const missing = tables.flatMap((table) => {
			const { schema = 'public', name, columns } = getTableConfig(table);
			// The client's `casing: 'snake_case'` stores a column named only by its key in snake case.
			const stored = (column: (typeof columns)[number]) =>
				column.keyAsName ? toSnakeCase(column.name) : column.name;
			return columns
				.map((column) => `${schema}.${name}.${stored(column)}`)
				.filter((column) => !present.has(column));
		});
		expect(missing).toEqual([]);
	});
});
