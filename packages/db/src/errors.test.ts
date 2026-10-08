import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { isUniqueViolation } from './errors';

describe('isUniqueViolation', () => {
	it('is false for anything that is not a Postgres error', () => {
		const lookalikes = [
			undefined,
			null,
			'23505',
			new Error('duplicate key value violates unique constraint'),
			// The node-postgres shape, which Bun's client does not produce.
			{ code: '23505' },
			new Error('Failed query', { cause: { code: '23505' } }),
		];
		for (const error of lookalikes) expect(isUniqueViolation(error)).toBe(false);
	});
});

/** Skipped without `DATABASE_URL`, like the other SQL tests here. Leaves nothing behind. */
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('isUniqueViolation against Postgres', () => {
	// Real errors from the server through Bun's client, never a hand-built stand-in: the driver is
	// what decides where the SQLSTATE goes, and a stand-in would keep passing if it moved again.
	const failure = (promise: PromiseLike<unknown>) =>
		Promise.resolve(promise).then(
			() => {
				throw new Error('the statement was expected to fail');
			},
			(error: unknown) => error,
		);

	it('recognises a duplicate key through Drizzle', async () => {
		const { db } = await import('./client');
		// A transaction pins one connection, which is where a temporary table lives; the failure
		// rolls it back, and the table with it.
		const error = await failure(
			db.transaction(async (tx) => {
				await tx.execute(sql`create temporary table unique_probe (slug text primary key)`);
				await tx.execute(sql`insert into unique_probe values ('taken')`);
				await tx.execute(sql`insert into unique_probe values ('taken')`);
			}),
		);
		expect(isUniqueViolation(error)).toBe(true);
	});

	it('recognises one thrown by the driver itself', async () => {
		const { pg } = await import('./client');
		const error = await failure(pg.unsafe('do $$ begin raise unique_violation; end $$'));
		expect(isUniqueViolation(error)).toBe(true);
	});

	it('is false for the other constraints Postgres enforces', async () => {
		const { db } = await import('./client');
		for (const condition of [
			'foreign_key_violation',
			'not_null_violation',
			'check_violation',
			'exclusion_violation',
		]) {
			const error = await failure(db.execute(sql.raw(`do $$ begin raise ${condition}; end $$`)));
			expect(isUniqueViolation(error)).toBe(false);
		}
	});
});
