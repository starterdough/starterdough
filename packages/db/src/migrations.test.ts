import { describe, expect, it } from 'bun:test';

// Pure helpers only, no database.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { diffMigrations, kitMigrations, productMigrations } = await import('./migrations');
const { resolveFlags } = await import('./flags');

describe('migration status', () => {
	const entries = [
		{ idx: 0, when: 100, tag: '0000_init' },
		{ idx: 1, when: 200, tag: '0001_auth' },
		{ idx: 2, when: 300, tag: '0002_flags' },
	];

	it('reports an up-to-date database', () => {
		expect(diffMigrations(entries, [100, 200, 300])).toEqual({
			shipped: 3,
			applied: 3,
			pending: [],
			unknown: 0,
			latestApplied: '0002_flags',
		});
	});

	it('lists shipped-but-unapplied migrations in order', () => {
		const status = diffMigrations(entries, [100]);
		expect(status.pending).toEqual(['0001_auth', '0002_flags']);
		expect(status.latestApplied).toBe('0000_init');
	});

	it('flags rows no shipped migration explains (database ahead of the build)', () => {
		expect(diffMigrations(entries, [100, 200, 300, 400]).unknown).toBe(1);
		expect(diffMigrations(entries, []).latestApplied).toBeNull();
	});

	it('reads the journals that ship with the package', () => {
		// Not a count: the free edition starts the kit's history over, and a product's history starts
		// empty, so what this guards is that both journals resolve and that the kit's entries are the
		// tags `migrate.ts` expects. migration-files.test.ts checks the files themselves.
		expect(kitMigrations.entries.length).toBeGreaterThan(0);
		expect(kitMigrations.entries.at(-1)?.tag).toMatch(/^\d{4}_/);
		expect(Array.isArray(productMigrations.entries)).toBe(true);
		expect([kitMigrations.table, productMigrations.table]).toEqual([
			'__drizzle_migrations',
			'__product_migrations',
		]);
	});
});

describe('feature flag resolution', () => {
	it('carries each flag through under its key', () => {
		const flags = [
			{ key: 'beta-editor', enabled: false },
			{ key: 'legacy-export', enabled: true },
			{ key: 'untouched', enabled: true },
		];
		expect(resolveFlags(flags)).toEqual({
			'beta-editor': false,
			'legacy-export': true,
			untouched: true,
		});
	});
});
