import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { moveProductMigrations, productTablesInKitIndex } from './move-product-migrations';

/**
 * A 1.0.0 product with a migration of its own in the kit's history, in the middle of merging a
 * kit release that added one too, in a throwaway repository. No database.
 *
 * Git only ever touches the fixture. A hook exports the repository it runs in (`GIT_DIR`,
 * `GIT_INDEX_FILE` and friends), and lefthook's pre-push `bun run verify` from a linked worktree
 * would hand those to the script's `git checkout` and `git rm`, which would then rewrite that
 * repository: every variable starting with `GIT_` is dropped, as scripts/upgrading.test.ts does.
 */
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Move test',
	GIT_AUTHOR_EMAIL: 'move@example.invalid',
	GIT_COMMITTER_NAME: 'Move test',
	GIT_COMMITTER_EMAIL: 'move@example.invalid',
	GIT_EDITOR: 'true',
	LEFTHOOK: '0',
};

const ORIGIN = '00000000-0000-0000-0000-000000000000';
const KIT = 'packages/db/drizzle';
const PRODUCT = 'packages/db/drizzle-product';
const SCHEMA = 'packages/db/src/schema';

let root: string;

function sh(cwd: string, line: string) {
	return Bun.spawnSync(['bash', '-c', line], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
}

function run(cwd: string, line: string): string {
	const result = sh(cwd, line);
	if (result.exitCode !== 0) throw new Error(`${line}\n${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function write(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

const read = (repo: string, path: string) => readFileSync(join(repo, path), 'utf8');

/** Appends a migration to `repo`'s kit history as drizzle-kit would: SQL, snapshot, journal entry. */
function generate(repo: string, name: string, when: number, table: string) {
	const journalPath = join(repo, KIT, 'meta/_journal.json');
	const journal = JSON.parse(read(repo, `${KIT}/meta/_journal.json`)) as {
		entries: Array<{
			idx: number;
			version: string;
			when: number;
			tag: string;
			breakpoints: boolean;
		}>;
	};
	const idx = journal.entries.length;
	const prefix = String(idx).padStart(4, '0');
	const previous = journal.entries.at(-1);
	const before = previous
		? (JSON.parse(read(repo, `${KIT}/meta/${previous.tag.slice(0, 4)}_snapshot.json`)) as {
				id: string;
				tables: Record<string, unknown>;
			})
		: { id: ORIGIN, tables: {} };
	const tag = `${prefix}_${name}`;
	write(
		join(repo, KIT, `${tag}.sql`),
		`CREATE TABLE "${table}" ("id" text PRIMARY KEY NOT NULL);\n`,
	);
	write(
		join(repo, KIT, `meta/${prefix}_snapshot.json`),
		JSON.stringify(
			{
				id: crypto.randomUUID(),
				prevId: before.id,
				version: '7',
				dialect: 'postgresql',
				tables: { ...before.tables, [`public.${table}`]: { name: table } },
				enums: {},
				schemas: {},
				sequences: {},
				roles: {},
				policies: {},
				views: {},
			},
			null,
			2,
		),
	);
	journal.entries.push({ idx, version: '7', when, tag, breakpoints: true });
	writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

/**
 * The seller's kit at 1.0.0 (two migrations) and 1.1.0 (a third, and the product history), and a
 * buyer's 1.0.0 product with a third migration of its own, generated after the kit's.
 */
function fixture(name: string): string {
	const repo = join(root, name);
	mkdirSync(repo);
	run(repo, 'git init -q -b main');
	write(
		join(repo, KIT, 'meta/_journal.json'),
		JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }),
	);
	generate(repo, 'init', 1000, 'account');
	generate(repo, 'more', 2000, 'profile');
	run(repo, 'git add -A && git commit -qm "Kit 1.0.0" && git tag kit/v1.0.0');

	run(repo, 'git switch -q -c kit-next');
	generate(repo, 'kit_thing', 3000, 'kit_thing');
	write(
		join(repo, PRODUCT, 'meta/_journal.json'),
		JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }, null, 2),
	);
	run(repo, 'git add -A && git commit -qm "Kit 1.1.0" && git tag kit/v1.1.0');

	run(repo, 'git switch -q main');
	generate(repo, 'notes', 4000, 'notes');
	run(repo, 'git add -A && git commit -qm "Notes"');
	return repo;
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'move-product-migrations-'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('moving a product’s migrations out of the kit’s history', () => {
	it('moves them during the merge, keeps their SQL and timestamp, and sets the kit folder to the release', () => {
		const repo = fixture('open-merge');
		const sql = read(repo, `${KIT}/0002_notes.sql`);
		const merge = sh(repo, 'git merge kit/v1.1.0');
		expect(merge.exitCode).not.toBe(0);
		expect(run(repo, 'git diff --name-only --diff-filter=U')).toContain(
			`${KIT}/meta/_journal.json`,
		);

		expect(moveProductMigrations({ top: repo, env })).toEqual([
			{ from: `${KIT}/0002_notes.sql`, to: `${PRODUCT}/0000_notes.sql` },
		]);

		expect(read(repo, `${PRODUCT}/0000_notes.sql`)).toBe(sql);
		const journal = JSON.parse(read(repo, `${PRODUCT}/meta/_journal.json`));
		expect(journal.entries).toEqual([
			{ idx: 0, version: '7', when: 4000, tag: '0000_notes', breakpoints: true },
		]);
		const snapshot = JSON.parse(read(repo, `${PRODUCT}/meta/0000_snapshot.json`));
		expect(Object.keys(snapshot.tables)).toEqual(['public.notes']);
		expect(snapshot.prevId).toBe(ORIGIN);

		// Nothing conflicts any more, and the kit's history is the release's, staged and on disk.
		expect(run(repo, 'git diff --name-only --diff-filter=U')).toBe('');
		expect(run(repo, `git diff --cached --name-only kit/v1.1.0 -- ${KIT}`)).toBe('');
		expect(run(repo, `git diff --name-only -- ${KIT} ${PRODUCT}`)).toBe('');

		// A second run finds the migration already moved.
		expect(moveProductMigrations({ top: repo, env })).toEqual([]);
		expect(JSON.parse(read(repo, `${PRODUCT}/meta/_journal.json`)).entries).toHaveLength(1);

		run(repo, 'git commit -qm "Merge kit 1.1.0"');
		expect(moveProductMigrations({ top: repo, ref: 'kit/v1.1.0', env })).toEqual([]);
	});

	it('names a moved table the kit schema still exports, which db:generate would drop', () => {
		const repo = fixture('kit-index');
		sh(repo, 'git merge kit/v1.1.0');
		moveProductMigrations({ top: repo, env });
		write(join(repo, SCHEMA, 'auth.ts'), "export const account = pgTable('account', {});\n");
		write(join(repo, SCHEMA, 'notes.ts'), 'export const notes = pgTable("notes", {});\n');
		write(join(repo, SCHEMA, 'index.ts'), "export * from './auth';\nexport * from './notes';\n");
		write(join(repo, SCHEMA, 'product.ts'), 'export {};\n');
		expect(productTablesInKitIndex(repo)).toEqual([{ table: 'notes', module: './notes' }]);

		write(join(repo, SCHEMA, 'index.ts'), "export * from './auth';\n");
		write(join(repo, SCHEMA, 'product.ts'), "export * from './notes';\n");
		expect(productTablesInKitIndex(repo)).toEqual([]);
	});

	it('refuses a kit release from before 1.1.0', () => {
		const repo = fixture('old-ref');
		expect(() => moveProductMigrations({ top: repo, ref: 'kit/v1.0.0', env })).toThrow(
			'kit/v1.0.0 is not a kit release from 1.1.0 on',
		);
		expect(() => moveProductMigrations({ top: repo, env })).toThrow('no merge is open');
		expect(run(repo, 'git status --porcelain')).toBe('');
	});

	it('refuses a merge that was resolved before it ran', () => {
		const repo = fixture('resolved');
		sh(repo, 'git merge kit/v1.1.0');
		// The old way: the release's journal and snapshot taken, the product's .sql left behind.
		run(
			repo,
			`git checkout kit/v1.1.0 -- ${KIT}/meta && git add -A && git commit -qm "Merge kit 1.1.0"`,
		);
		expect(() => moveProductMigrations({ top: repo, ref: 'kit/v1.1.0', env })).toThrow(
			`does not list ${KIT}/0002_notes.sql`,
		);
		expect(run(repo, 'git status --porcelain')).toBe('');
	});
});
