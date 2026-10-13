import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Both migration histories as files: what a merge or a hand edit can break with nothing else
 * noticing. Merging two branches that each generated a migration leaves a journal whose entries
 * clash, and drizzle-kit itself still reports that all is well. No database.
 */
const ORIGIN = '00000000-0000-0000-0000-000000000000';
const packageDir = join(import.meta.dir, '..');

interface Entry {
	idx: number;
	when: number;
	tag: string;
}

interface Snapshot {
	id: string;
	prevId: string;
	tables: Record<string, unknown>;
}

function history(dir: string) {
	const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
		entries: Entry[];
	};
	return {
		entries: journal.entries,
		sql: readdirSync(dir).filter((name) => name.endsWith('.sql')),
		snapshots: readdirSync(join(dir, 'meta')).filter((name) => name.endsWith('_snapshot.json')),
		snapshot: (tag: string) =>
			JSON.parse(
				readFileSync(join(dir, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8'),
			) as Snapshot,
	};
}

const kitDir = join(packageDir, 'drizzle');
const productDir = join(packageDir, 'drizzle-product');
// The free edition's own kit history, kept in the paid repository it is generated from.
const freeDir = join(packageDir, '../../free-edition/packages/db/drizzle');

for (const [label, dir] of [
	['packages/db/drizzle', kitDir],
	['packages/db/drizzle-product', productDir],
	['free-edition/packages/db/drizzle', freeDir],
] as const) {
	// Bun runs a skipped block's body too, so each case reads the files itself.
	describe.skipIf(!existsSync(dir))(label, () => {
		it('has one .sql file and one snapshot per journal entry, and nothing else', () => {
			const { entries, sql, snapshots } = history(dir);
			expect(sql.sort()).toEqual(entries.map((entry) => `${entry.tag}.sql`).sort());
			expect(snapshots.sort()).toEqual(
				entries.map((entry) => `${entry.tag.slice(0, 4)}_snapshot.json`).sort(),
			);
		});

		// Drizzle's migrator applies a migration only when its `when` is newer than the newest one
		// applied, so an entry that sorts before an earlier one is skipped on every database that ran
		// that earlier one. `migrate.ts` catches it at deploy time; this catches it at commit time.
		it('numbers its entries 0, 1, 2… with timestamps that only increase', () => {
			const { entries } = history(dir);
			const problems = entries.flatMap((entry, i) => {
				const previous = entries[i - 1];
				return [
					entry.idx === i ? [] : [`${entry.tag}: idx ${entry.idx}, expected ${i}`],
					entry.tag.startsWith(`${String(i).padStart(4, '0')}_`)
						? []
						: [`${entry.tag}: tag does not start with ${String(i).padStart(4, '0')}_`],
					previous && entry.when <= previous.when
						? [`${entry.tag}: when ${entry.when} is not after ${previous.tag}'s`]
						: [],
				].flat();
			});
			expect(problems).toEqual([]);
		});

		// Each snapshot names the one it was diffed against, and drizzle-kit diffs the next migration
		// against the last; two snapshots claiming the same parent are two branches merged naively.
		it('chains each snapshot to the one before it', () => {
			const { entries, snapshot } = history(dir);
			let previous = ORIGIN;
			const broken: string[] = [];
			for (const entry of entries) {
				const current = snapshot(entry.tag);
				if (current.prevId !== previous) broken.push(`${entry.tag}: prevId ${current.prevId}`);
				previous = current.id;
			}
			expect(broken).toEqual([]);
		});
	});
}

// Only the kit's history and the product's: the free edition's shares the kit's tables by design.
describe('the kit history and the product history', () => {
	const kit = history(kitDir);
	const product = history(productDir);

	// `rehomeProductMigrations` moves a database's history rows by timestamp.
	it('never share a timestamp', () => {
		const kitWhen = new Set(kit.entries.map((entry) => entry.when));
		expect(product.entries.filter((entry) => kitWhen.has(entry.when)).map((e) => e.tag)).toEqual(
			[],
		);
	});

	// `src/schema/product.ts` re-exporting a kit table makes `db:generate` create it a second time.
	it('never both create a table', () => {
		const tablesOf = (h: typeof kit) => {
			const last = h.entries.at(-1);
			return last ? Object.keys(h.snapshot(last.tag).tables) : [];
		};
		const kitTables = new Set(tablesOf(kit));
		expect(tablesOf(product).filter((table) => kitTables.has(table))).toEqual([]);
	});
});
