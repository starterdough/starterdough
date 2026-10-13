import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import type { JournalEntry } from './migrations';

// Loading the journals needs no database; the cases below each open their own.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { kitMigrations, productMigrations, rehomeProductMigrations } = await import('./migrations');

/**
 * The kit's migration history and the product's, applied by `migrate.ts` as a deploy runs it, on
 * databases each history has already reached in part. Skipped without `DATABASE_URL`. It creates
 * and drops its own databases next to that one, so the role needs CREATEDB, as
 * `free-edition-upgrade.test.ts` does.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

/** The last migration 1.0.0 shipped: where the first databases stood when 1.1.0 came out. */
const LAST_1_0_0_MIGRATION = '0010_repair_jsonb';

describeDb('two migration histories', () => {
	const token = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
	const names = {
		upgrade: `histories_${token}_upgrade`,
		older: `histories_${token}_older`,
		rehome: `histories_${token}_rehome`,
		empty: `histories_${token}_empty`,
	};
	let admin: SQL;
	const clients: SQL[] = [];
	const scratch: string[] = [];

	function urlOf(name: string): string {
		const url = new URL(databaseUrl ?? '');
		url.pathname = `/${name}`;
		return url.toString();
	}

	function connect(name: string): SQL {
		const client = new SQL(urlOf(name), { max: 2 });
		clients.push(client);
		return client;
	}

	/** `migrate.ts` as the `migrate` service runs it, against `name`. */
	function runMigrate(name: string): { exitCode: number; output: string } {
		const result = Bun.spawnSync(['bun', 'run', 'src/migrate.ts'], {
			cwd: join(import.meta.dir, '..'),
			env: { ...process.env, SKIP_ENV_VALIDATION: '1', DATABASE_URL: urlOf(name) },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	}

	/** A migrations folder holding the first `count` entries of the kit's history. */
	function kitFolderOf(count: number): string {
		const dir = mkdtempSync(join(tmpdir(), 'kit-history-'));
		scratch.push(dir);
		const entries = kitMigrations.entries.slice(0, count);
		mkdirSync(join(dir, 'meta'));
		writeFileSync(
			join(dir, 'meta/_journal.json'),
			JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.map(full) }),
		);
		for (const { tag } of entries) {
			copyFileSync(join(kitMigrations.folder, `${tag}.sql`), join(dir, `${tag}.sql`));
		}
		return dir;
	}

	/** A journal entry as drizzle-kit writes it; the migrator reads `breakpoints` too. */
	function full(entry: JournalEntry) {
		return { ...entry, version: '7', breakpoints: true };
	}

	async function appliedWhen(client: SQL, table: string): Promise<number[]> {
		const rows: Array<{ created_at: string }> = await client.unsafe(
			`select created_at from drizzle.${table} order by created_at`,
		);
		return rows.map((row) => Number(row.created_at));
	}

	const kitCount = kitMigrations.entries.length;
	const productCount = productMigrations.entries.length;
	const statusLine = `✓ migrations applied (kit ${kitCount} of ${kitCount}, product ${productCount} of ${productCount})`;

	beforeAll(async () => {
		admin = new SQL(databaseUrl ?? '', { max: 1 });
		for (const name of Object.values(names)) await admin.unsafe(`create database "${name}"`);
	});

	afterAll(async () => {
		for (const client of clients) await client.close();
		for (const name of Object.values(names)) {
			await admin?.unsafe(`drop database if exists "${name}" with (force)`);
		}
		await admin?.close();
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	it('upgrades a database at the last 1.0.0 migration', async () => {
		// The reference deployments stood there. The free edition started its history over after
		// 1.0.0, so there the database starts from the whole of it.
		const { entries } = kitMigrations;
		const last = entries.findIndex((entry) => entry.tag === LAST_1_0_0_MIGRATION);
		const client = connect(names.upgrade);
		await migrate(drizzle({ client }), {
			migrationsFolder: kitFolderOf(last < 0 ? entries.length : last + 1),
		});

		const upgraded = runMigrate(names.upgrade);
		expect(upgraded.output).toContain(statusLine);
		expect(upgraded.exitCode).toBe(0);
		expect(await appliedWhen(client, '__drizzle_migrations')).toEqual(
			entries.map((entry) => entry.when),
		);
		const [{ present }] =
			await client`select to_regclass('drizzle.__product_migrations') is not null as present`;
		expect(present).toBe(true);

		const again = runMigrate(names.upgrade);
		expect(again.output).toContain(statusLine);
		expect(again.exitCode).toBe(0);
	});

	// It needs a kit migration to hold back. A product with migrations of its own would apply them
	// after the fixture's, and Drizzle would skip those older than it; the case is about the kit's.
	it.skipIf(kitCount < 2 || productCount > 0)(
		'applies a kit migration older than an applied product migration',
		async () => {
			const { entries } = kitMigrations;
			const client = connect(names.older);
			await migrate(drizzle({ client }), { migrationsFolder: kitFolderOf(entries.length - 1) });

			// A product migration generated after the kit's last one, and applied before it: in one
			// history, Drizzle would now skip the kit's for good.
			const lastKit = entries.at(-1) as JournalEntry;
			const product = mkdtempSync(join(tmpdir(), 'product-history-'));
			scratch.push(product);
			const fixture = { idx: 0, when: Math.max(Date.now(), lastKit.when + 1), tag: '0000_fixture' };
			mkdirSync(join(product, 'meta'));
			writeFileSync(
				join(product, 'meta/_journal.json'),
				JSON.stringify({ version: '7', dialect: 'postgresql', entries: [full(fixture)] }),
			);
			writeFileSync(
				join(product, `${fixture.tag}.sql`),
				'CREATE TABLE "fixture_note" ("id" text PRIMARY KEY NOT NULL, "user_id" text NOT NULL REFERENCES "user"("id"));',
			);
			await migrate(drizzle({ client }), {
				migrationsFolder: product,
				migrationsSchema: 'drizzle',
				migrationsTable: '__product_migrations',
			});

			const result = runMigrate(names.older);
			expect(result.output).toContain(`kit ${entries.length} of ${entries.length}`);
			expect(result.exitCode).toBe(0);
			expect(await appliedWhen(client, '__drizzle_migrations')).toContain(lastKit.when);
			expect(await appliedWhen(client, '__product_migrations')).toEqual([fixture.when]);
		},
	);

	it('moves only the product’s rows to its history, once, and refuses a shared timestamp', async () => {
		const client = connect(names.rehome);
		const kit = [
			{ idx: 0, when: 100, tag: '0000_init' },
			{ idx: 1, when: 200, tag: '0001_more' },
		];
		const product = [{ idx: 0, when: 300, tag: '0000_mine' }];
		// What a release before 1.1.0 left: the product's migration recorded in the kit's table.
		await client`create schema drizzle`;
		await client`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
		await client`insert into drizzle.__drizzle_migrations (hash, created_at) values ('kit-0', 100), ('kit-1', 200), ('mine-0', 300)`;

		expect(await rehomeProductMigrations(client, kit, product)).toBe(1);
		expect(await appliedWhen(client, '__drizzle_migrations')).toEqual([100, 200]);
		const moved: Array<{ hash: string; created_at: string }> =
			await client`select hash, created_at from drizzle.__product_migrations`;
		expect(moved).toEqual([{ hash: 'mine-0', created_at: '300' }]);

		expect(await rehomeProductMigrations(client, kit, product)).toBe(0);
		expect(await appliedWhen(client, '__product_migrations')).toEqual([300]);

		const clash = [{ idx: 0, when: 200, tag: '0000_clash' }];
		await expect(rehomeProductMigrations(client, kit, clash)).rejects.toThrow('0000_clash');
		expect(await appliedWhen(client, '__drizzle_migrations')).toEqual([100, 200]);
	});

	it('leaves a database no migration has run on alone', async () => {
		const client = connect(names.empty);
		const product = [{ idx: 0, when: 300, tag: '0000_mine' }];
		expect(await rehomeProductMigrations(client, [], product)).toBe(0);
		const [{ present }] = await client`select to_regnamespace('drizzle') is not null as present`;
		expect(present).toBe(false);
	});
});
