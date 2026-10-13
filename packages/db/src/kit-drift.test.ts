import { describe, expect, it } from 'bun:test';
import { kitDrift } from './kit-drift';

/** One drizzle-kit run takes about a second, more while other suites load the machine. */
const TIMEOUT = 30_000;

/**
 * The kit's tables as the schema declares them match what the migrations create. In a product it
 * fails while a change to a kit table (a Better Auth plugin after `auth:schema`, an index of yours)
 * has no migration of yours: `bun run db:kit-drift` prints the SQL to put in one. In the kit's own
 * repository it fails on a kit schema change nobody ran `generate:kit` for. No database: drizzle-kit
 * diffs the schema against the snapshots.
 */
describe('the kit tables', () => {
	it(
		'need no SQL that a migration does not already hold',
		() => {
			expect(kitDrift()).toEqual([]);
		},
		TIMEOUT,
	);
});
