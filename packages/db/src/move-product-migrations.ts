/**
 * `bun run db:move-product-migrations`: once, when a product upgrades from a kit release before
 * 1.1.0, move its own migrations out of the kit's history.
 *
 *   bun run db:move-product-migrations              while the merge of the kit release is open
 *   bun run db:move-product-migrations --kit <ref>  after it, naming the kit release you merged
 *
 * Before 1.1.0 `db:generate` wrote a product's migrations into `packages/db/drizzle`, the kit's
 * history. This takes every journal entry there that the kit release `<ref>` does not have and
 * writes it to `packages/db/drizzle-product` as the next product migration: the same SQL, so the
 * same hash, and the same journal `when`, so `db:migrate` recognises a database that already ran it
 * and moves its history row (`rehomeProductMigrations`). Its snapshot keeps only the product's own
 * objects. Then the kit's folder becomes exactly the release's. It stages its changes and commits
 * nothing, and it never touches a database.
 *
 * One-shot tooling for the move to 1.1.0, to be removed in 2.0.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ORIGIN = '00000000-0000-0000-0000-000000000000';
/** Every kind of object a drizzle-kit snapshot keys by name. */
const SNAPSHOT_KEYS = ['tables', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views'];
const KIT = 'packages/db/drizzle';
const PRODUCT = 'packages/db/drizzle-product';
const SCHEMA = 'packages/db/src/schema';

const snapshotOf = (tag: string) => `meta/${tag.slice(0, 4)}_snapshot.json`;

interface Entry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

interface Journal {
	version: string;
	dialect: string;
	entries: Entry[];
}

type Snapshot = Record<string, unknown> & { id: string; prevId: string };

export interface MoveOptions {
	/** The repository's top-level directory. */
	top: string;
	/** The kit release to compare with; `MERGE_HEAD` when omitted and a merge is open. */
	ref?: string;
	/** The environment every git command runs with. */
	env: Record<string, string | undefined>;
}

export interface Moved {
	from: string;
	to: string;
}

/** Moves the product's migrations and returns what moved; throws on anything it will not do. */
export function moveProductMigrations({ top, ref: given, env }: MoveOptions): Moved[] {
	const git = (...args: string[]): Buffer => {
		const result = Bun.spawnSync(['git', ...args], {
			cwd: top,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
		return result.stdout;
	};
	const exists = (spec: string) =>
		Bun.spawnSync(['git', 'cat-file', '-e', spec], { cwd: top, env }).exitCode === 0;
	const show = (ref: string, path: string) => git('show', `${ref}:${path}`);
	const json = <T>(ref: string, path: string) => JSON.parse(show(ref, path).toString()) as T;
	const lines = (output: Buffer) => output.toString().split('\n').filter(Boolean);
	const objectsOf = (snapshot: Snapshot, key: string) =>
		(snapshot[key] ?? {}) as Record<string, unknown>;

	const ref = given ?? (exists('MERGE_HEAD') ? 'MERGE_HEAD' : undefined);
	if (!ref) {
		throw new Error(
			'no merge is open: run this while the merge of the kit release is still open, or name the release you merged with --kit (kit-renamed, or kit/v1.1.0).',
		);
	}
	// A release before 1.1.0 has no product history, and its kit history lacks 1.1.0's own
	// migrations, which this would then take for the product's and move.
	if (!exists(`${ref}:${PRODUCT}/meta/_journal.json`)) {
		throw new Error(
			`${ref} is not a kit release from 1.1.0 on (it has no ${PRODUCT}). Name the release you are merging.`,
		);
	}

	const ours = json<Journal>('HEAD', `${KIT}/meta/_journal.json`);
	const theirs = json<Journal>(ref, `${KIT}/meta/_journal.json`);
	// A merge resolved before this ran leaves HEAD's journal without the product's entries while
	// their files stay, and nothing here would find them.
	const listed = new Set(ours.entries.map((entry) => `${KIT}/${entry.tag}.sql`));
	const orphans = lines(git('ls-tree', '-r', '--name-only', 'HEAD', '--', `${KIT}/`)).filter(
		(path) => /^[^/]+\.sql$/.test(path.slice(KIT.length + 1)) && !listed.has(path),
	);
	if (orphans.length > 0) {
		throw new Error(
			`HEAD's ${KIT}/meta/_journal.json does not list ${orphans.join(', ')}, so the merge was resolved before this ran. Undo it (git merge --abort while it is open, or reset to the commit before it), merge again, and run this while the merge is still open.`,
		);
	}

	const productJournal = join(top, PRODUCT, 'meta/_journal.json');
	const product: Journal = existsSync(productJournal)
		? (JSON.parse(readFileSync(productJournal, 'utf8')) as Journal)
		: json<Journal>(ref, `${PRODUCT}/meta/_journal.json`);
	const kitWhen = new Set(theirs.entries.map((entry) => entry.when));
	// Entries already in the product's history were moved by an earlier run.
	const movedWhen = new Set(product.entries.map((entry) => entry.when));
	const mine = ours.entries.filter(
		(entry) => !kitWhen.has(entry.when) && !movedWhen.has(entry.when),
	);

	const moved: Moved[] = [];
	if (mine.length > 0) {
		const last = product.entries.at(-1);
		const first = mine[0] as Entry;
		if (last && first.when <= last.when) {
			throw new Error(
				`${PRODUCT} already has a migration newer than ${first.tag}, so Drizzle would skip it. Move it by hand.`,
			);
		}

		// The kit's objects, as the release leaves them and as the product's last kit migration did.
		const kitSnapshots: Snapshot[] = [];
		const lastTheirs = theirs.entries.at(-1);
		if (lastTheirs) kitSnapshots.push(json<Snapshot>(ref, `${KIT}/${snapshotOf(lastTheirs.tag)}`));
		const lastKitOfOurs = ours.entries.filter((entry) => kitWhen.has(entry.when)).at(-1);
		if (lastKitOfOurs) {
			kitSnapshots.push(json<Snapshot>('HEAD', `${KIT}/${snapshotOf(lastKitOfOurs.tag)}`));
		}
		const kitObjects = new Set(
			kitSnapshots.flatMap((snapshot) =>
				SNAPSHOT_KEYS.flatMap((key) =>
					Object.keys(objectsOf(snapshot, key)).map((name) => `${key}:${name}`),
				),
			),
		);

		let prevId = last
			? (JSON.parse(readFileSync(join(top, PRODUCT, snapshotOf(last.tag)), 'utf8')) as Snapshot).id
			: ORIGIN;
		mkdirSync(join(top, PRODUCT, 'meta'), { recursive: true });
		for (const entry of mine) {
			const idx = product.entries.length;
			const tag = `${String(idx).padStart(4, '0')}${entry.tag.slice(4)}`;
			// The blob's bytes as they are: the migrator hashes the file, and the hash must not change.
			writeFileSync(join(top, PRODUCT, `${tag}.sql`), show('HEAD', `${KIT}/${entry.tag}.sql`));
			const snapshot = json<Snapshot>('HEAD', `${KIT}/${snapshotOf(entry.tag)}`);
			for (const key of SNAPSHOT_KEYS) {
				const objects = objectsOf(snapshot, key);
				for (const name of Object.keys(objects)) {
					if (kitObjects.has(`${key}:${name}`)) delete objects[name];
				}
			}
			snapshot.prevId = prevId;
			prevId = snapshot.id;
			writeFileSync(join(top, PRODUCT, snapshotOf(tag)), JSON.stringify(snapshot, null, 2));
			product.entries.push({ ...entry, idx, tag });
			moved.push({ from: `${KIT}/${entry.tag}.sql`, to: `${PRODUCT}/${tag}.sql` });
		}
		writeFileSync(productJournal, JSON.stringify(product, null, 2));
	}

	// The kit's folder becomes exactly the release's: its files back, the product's out.
	git('checkout', ref, '--', KIT);
	const released = new Set(lines(git('ls-tree', '-r', '--name-only', ref, '--', `${KIT}/`)));
	for (const path of new Set(lines(git('ls-files', '--', `${KIT}/`)))) {
		if (released.has(path)) continue;
		rmSync(join(top, path), { force: true });
		git('rm', '-q', '--cached', '--ignore-unmatch', '--', path);
	}
	git('add', '--', KIT, PRODUCT);
	return moved;
}

/** A table of the product's history that `schema/index.ts` still exports. */
export interface KitIndexExport {
	table: string;
	/** The module `index.ts` re-exports it from, as written there: `./notes`. */
	module: string;
}

/**
 * The tables in the product's newest snapshot that `packages/db/src/schema/index.ts`, the kit's
 * schema, still exports rather than `schema/product.ts`. `db:generate` reads only `product.ts`, so
 * it would propose dropping each of them. Read from the working tree by name: a `pgTable('<name>'`
 * in a module that `index.ts` re-exports (`export * from './notes'`).
 */
export function productTablesInKitIndex(top: string): KitIndexExport[] {
	const read = (path: string) => readFileSync(join(top, path), 'utf8');
	const journal = `${PRODUCT}/meta/_journal.json`;
	const index = `${SCHEMA}/index.ts`;
	if (!existsSync(join(top, journal)) || !existsSync(join(top, index))) return [];
	const last = (JSON.parse(read(journal)) as Journal).entries.at(-1);
	if (!last) return [];
	const snapshot = JSON.parse(read(`${PRODUCT}/${snapshotOf(last.tag)}`)) as Snapshot;
	const tables = new Set(
		Object.entries((snapshot.tables ?? {}) as Record<string, { name?: string }>).map(
			([key, table]) => table.name ?? key.slice(key.lastIndexOf('.') + 1),
		),
	);

	const found: KitIndexExport[] = [];
	for (const [, module = ''] of read(index).matchAll(
		/^export\b[^;]*?\bfrom\s+['"](\.[^'"]+)['"]/gm,
	)) {
		const base = `${SCHEMA}/${module.replace(/\.[jt]s$/, '')}`;
		const file = [`${base}.ts`, `${base}/index.ts`].find((path) => existsSync(join(top, path)));
		if (!file) continue;
		for (const [, table = ''] of read(file).matchAll(
			/\b(?:pgTable|\.table)\(\s*['"`]([^'"`]+)['"`]/g,
		)) {
			if (tables.has(table)) found.push({ table, module });
		}
	}
	return found;
}

if (import.meta.main) {
	try {
		const at = Bun.argv.indexOf('--kit');
		const ref = at >= 0 ? Bun.argv[at + 1] : undefined;
		if (at >= 0 && !ref) throw new Error('--kit needs the kit release: --kit kit/v1.1.0');
		const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
			cwd: resolve(import.meta.dir, '..'),
			stdout: 'pipe',
		})
			.stdout.toString()
			.trim();
		const moved = moveProductMigrations({ top, ref, env: process.env });
		if (moved.length === 0) {
			console.log(
				`Nothing to move: every migration in ${KIT} is the kit release's. Its folder now matches the release.`,
			);
		} else {
			for (const { from, to } of moved) console.log(`  ${from} → ${to}`);
			console.log(`
Moved ${moved.length} migration(s) to ${PRODUCT} and staged both folders; nothing is committed.
  1. Export your tables from packages/db/src/schema/product.ts instead of schema/index.ts.
  2. bun run db:generate   must say "No schema changes".
  3. bun run db:migrate    moves the history rows of each database that already ran them.
To undo: git merge --abort while the merge is open (it abandons the merge too); otherwise
  git restore --source=HEAD --staged --worktree ${KIT} ${PRODUCT}`);
		}
		for (const { table, module } of productTablesInKitIndex(top)) {
			console.warn(
				`! ${SCHEMA}/index.ts still exports ${table} (from ${module}), a table of your own history now: export it from schema/product.ts instead, or db:generate will propose dropping it.`,
			);
		}
	} catch (error) {
		console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
