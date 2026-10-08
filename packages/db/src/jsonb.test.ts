import { describe, expect, it } from 'bun:test';
import { eq, getTableColumns, getTableName, is, sql, Table } from 'drizzle-orm';
import { jsonb as drizzleJsonb, integer, pgTable } from 'drizzle-orm/pg-core';
import type { DbTransaction } from './client';
import * as schema from './schema';
import { jsonb } from './schema/jsonb';

describe('jsonb columns', () => {
	// drizzle-orm's own `json()`/`jsonb()` store an object as a jsonb string on Bun's client (see
	// `schema/jsonb.ts`). A schema file generated or written later must not bring them back.
	it('use the schema’s `jsonb`, never drizzle-orm’s', () => {
		const offenders = Object.values<unknown>(schema)
			.filter((value): value is Table => is(value, Table))
			.flatMap((table) =>
				Object.values(getTableColumns(table))
					.filter((column) => column.columnType === 'PgJson' || column.columnType === 'PgJsonb')
					.map((column) => `${getTableName(table)}.${column.name}`),
			);
		expect(offenders).toEqual([]);
	});
});

/** Skipped without `DATABASE_URL`, like the other SQL tests here. Leaves nothing behind. */
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('the jsonb column against Postgres', () => {
	// One temporary table, written with this column type (`value`) and with drizzle-orm's (`legacy`,
	// what every row written before it holds), then read back with this type for both.
	const written = pgTable('jsonb_probe', {
		id: integer().primaryKey(),
		value: jsonb(),
		legacy: drizzleJsonb(),
	});
	const reread = pgTable('jsonb_probe', {
		id: integer().primaryKey(),
		value: jsonb(),
		legacy: jsonb(),
	});
	const values = [{ name: 'Acme', nested: { n: 1 } }, [1, 'two'], 'text', 42, false];

	/** Runs `test` with an empty `jsonb_probe`. A transaction pins the one connection it lives on. */
	async function withProbe(test: (tx: DbTransaction) => Promise<void>): Promise<void> {
		const { db } = await import('./client');
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`create temporary table jsonb_probe (id integer primary key, value jsonb, legacy jsonb) on commit drop`,
			);
			await test(tx);
		});
	}

	it('stores every JSON value as itself', async () => {
		await withProbe(async (tx) => {
			await tx.insert(written).values(values.map((value, id) => ({ id, value, legacy: value })));
			const stored = await tx.execute<{ value: string; legacy: string; name: string | null }>(
				sql`select jsonb_typeof(value) as value, jsonb_typeof(legacy) as legacy, value->>'name' as name from jsonb_probe order by id`,
			);
			expect(stored.map((row) => row.value)).toEqual([
				'object',
				'array',
				'string',
				'number',
				'boolean',
			]);
			expect(stored[0]?.name).toBe('Acme');
			expect(stored.map((row) => row.legacy)).toEqual(values.map(() => 'string'));

			await tx
				.update(written)
				.set({ value: { changed: true } })
				.where(eq(written.id, 1));
			const [updated] = await tx.execute<{ value: string }>(
				sql`select jsonb_typeof(value) as value from jsonb_probe where id = 1`,
			);
			expect(updated?.value).toBe('object');

			const read = await tx.select().from(reread).orderBy(reread.id);
			expect(read.map((row) => row.value)).toEqual([
				values[0],
				{ changed: true },
				...values.slice(2),
			]);
			// What drizzle-orm's jsonb() stored reads as the JSON text it holds, until a migration
			// such as 0010_repair_jsonb converts it.
			expect(read.map((row) => row.legacy)).toEqual(values.map((value) => JSON.stringify(value)));
		});
	});

	it('reads a jsonb string back as that string, however much it looks like JSON', async () => {
		const strings = ['42', 'true', 'null', '{"a":1}', '[1,2]', ' 7 ', '"quoted"'];
		await withProbe(async (tx) => {
			await tx.insert(written).values(strings.map((value, id) => ({ id, value })));
			for (const [id, value] of strings.entries()) {
				await tx.execute(
					sql`insert into jsonb_probe (id, value) values (${id + 100}, to_jsonb(${value}::text))`,
				);
			}
			const stored = await tx.execute<{ type: string }>(
				sql`select jsonb_typeof(value) as type from jsonb_probe order by id`,
			);
			expect(stored.map((row) => row.type)).toEqual([...strings, ...strings].map(() => 'string'));
			const read = await tx.select().from(reread).orderBy(reread.id);
			expect(read.map((row) => row.value)).toEqual([...strings, ...strings]);
		});
	});

	it('stores U+0000 and half a surrogate pair as U+FFFD, in keys and values at any depth', async () => {
		const value = {
			'na\u0000me': 'Acme\u0000',
			cut: 'emoji \ud83d',
			list: [
				'\ude00 low',
				{ 'key\ud83d': ['\ud83d\ude00 whole', 'a\u0000b', 7, null] },
				['nested \u0000'],
			],
			at: new Date(0),
		};
		await withProbe(async (tx) => {
			await tx.insert(written).values([
				{ id: 0, value },
				{ id: 1, value: 'top\u0000level \ud83d' },
				{ id: 2, value: ['\u0000'] },
			]);
			const [stored] = await tx.execute<{ type: string; name: string | null }>(
				sql`select jsonb_typeof(value) as type, value->>'na\uFFFDme' as name from jsonb_probe where id = 0`,
			);
			expect(stored).toEqual({ type: 'object', name: 'Acme\uFFFD' });
			const read = await tx.select().from(reread).orderBy(reread.id);
			expect(read.map((row) => row.value)).toEqual([
				{
					'na\uFFFDme': 'Acme\uFFFD',
					cut: 'emoji \uFFFD',
					list: [
						'\uFFFD low',
						{ 'key\uFFFD': ['\ud83d\ude00 whole', 'a\uFFFDb', 7, null] },
						['nested \uFFFD'],
					],
					at: '1970-01-01T00:00:00.000Z',
				},
				'top\uFFFDlevel \uFFFD',
				['\uFFFD'],
			]);
		});
	});
});
