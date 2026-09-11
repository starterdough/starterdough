import { describe, expect, it } from 'bun:test';

// Pure helpers only — no database.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { diffMigrations, shippedMigrations } = await import('./migrations');
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

	it('reads the journal that ships with the package', () => {
		// Not a count: the free edition starts its history over, so what this guards is that the
		// journal resolves at all and that its entries are the tags `migrate.ts` expects.
		expect(shippedMigrations.length).toBeGreaterThan(0);
		expect(shippedMigrations.at(-1)?.tag).toMatch(/^\d{4}_/);
	});

	// Drizzle's migrator compares each file against the single newest applied `when`, so a journal
	// entry whose timestamp precedes an earlier-applied one is skipped for good — what merging two
	// branches that both generated a migration produces. `migrate.ts` catches it at deploy time; this
	// catches it at commit time. Fix by regenerating the newer migration so it sorts last.
	it('ships a journal whose timestamps increase with the index', () => {
		const outOfOrder = shippedMigrations.filter(
			(entry, i) => i > 0 && entry.when <= (shippedMigrations[i - 1]?.when ?? 0),
		);
		expect(outOfOrder.map((entry) => entry.tag)).toEqual([]);
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
