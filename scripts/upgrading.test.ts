/**
 * UPGRADING.md, followed to the letter against a miniature kit. Its ```sh blocks run verbatim with
 * the real `scripts/rename.ts`; only the two repository URLs point at local fixtures. A release
 * that rewrites lines holding the kit's name, slug, scope and identifier has to merge into a
 * renamed fork without a conflict, and only a line both sides changed may conflict. The fixture's
 * `bun install` has nothing to install and its `lint:fix` is a no-op, so the case stays offline and
 * fast; what they do to the real kit's lockfile and imports is the page's own business.
 *
 * Git only ever touches the fixtures. A hook exports the repository it runs in (`GIT_DIR`,
 * `GIT_INDEX_FILE` and friends), and lefthook's pre-push `bun run verify` from a linked worktree
 * would hand those to every command here, which would then commit and tag in that repository. And
 * only `file:` URLs are allowed, so a GitHub URL the substitution misses fails the case instead of
 * cloning the real kit.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const page = readFileSync(join(repoRoot, 'UPGRADING.md'), 'utf8');
const RENAME =
	'bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write';

/** Read per command, so a case can stand in for the hook by setting `GIT_DIR` itself. */
function env(): Record<string, string | undefined> {
	const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
	return {
		...Object.fromEntries(inherited),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Upgrade test',
		GIT_AUTHOR_EMAIL: 'upgrade@example.invalid',
		GIT_COMMITTER_NAME: 'Upgrade test',
		GIT_COMMITTER_EMAIL: 'upgrade@example.invalid',
		GIT_EDITOR: 'true',
		GIT_ALLOW_PROTOCOL: 'file',
		GIT_TERMINAL_PROMPT: '0',
		LEFTHOOK: '0',
	};
}

function sh(cwd: string, line: string) {
	return Bun.spawnSync(['bash', '-c', line], { cwd, env: env(), stdout: 'pipe', stderr: 'pipe' });
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

function conflicts(cwd: string): string[] {
	return run(cwd, 'git diff --name-only --diff-filter=U').split('\n').filter(Boolean);
}

/** Every ```sh block this edition renders, including the one indented under a list item. */
function blocks(): string[][] {
	const found: string[][] = [];
	let current: string[] | undefined;
	for (const line of page.split('\n')) {
		if (!current && /^ {0,3}```sh\s*$/.test(line)) current = [];
		else if (current && line.trim() === '```') {
			found.push(current);
			current = undefined;
		} else current?.push(line.trim());
	}
	return found;
}

function block(has: string, lacks?: string): string[] {
	const matches = blocks().filter(
		(lines) => lines.some((l) => l.includes(has)) && !lines.some((l) => lacks && l.includes(lacks)),
	);
	if (matches.length !== 1)
		throw new Error(`expected one block with "${has}", found ${matches.length}`);
	return matches[0] as string[];
}

/** Each case spawns a few dozen git and bun processes; bun's 5-second default is tight under load. */
const TIMEOUT = 60_000;

let root: string;
let upstream: string;
let seller: string;

/**
 * A block's lines as the fixtures run them. The kit's URL is matched by shape, not by owner:
 * `bun run rename` rewrites this file in a buyer's fork but leaves the page's URL alone.
 */
function* commands(lines: string[], origin: string): Generator<string> {
	for (const raw of lines) {
		if (!raw || raw.startsWith('#')) continue;
		const line = raw
			.replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git/, `file://${upstream}`)
			.replace('git@github.com:me/my-product.git', `file://${origin}`);
		if (line.includes('github.com')) throw new Error(`no fixture stands in for: ${line}`);
		yield line;
	}
}

/** Runs a block line by line; a merge may stop on a conflict. Returns the directory it ends in. */
function follow(lines: string[], cwd: string, origin: string): string {
	let at = cwd;
	for (const line of commands(lines, origin)) {
		if (line.startsWith('cd ')) {
			at = join(at, line.slice(3).trim());
			continue;
		}
		const result = sh(at, line);
		if (result.exitCode !== 0 && !(line.startsWith('git merge') && conflicts(at).length)) {
			throw new Error(`${line}\n${result.stdout.toString()}${result.stderr.toString()}`);
		}
	}
	return at;
}

/**
 * Runs every line of a block whatever the one before it did, as a shell does with a pasted block.
 * Returns what the failing lines printed.
 */
function paste(lines: string[], cwd: string, origin: string): string {
	let at = cwd;
	let failed = '';
	for (const line of commands(lines, origin)) {
		if (line.startsWith('cd ')) {
			at = join(at, line.slice(3).trim());
			continue;
		}
		const result = sh(at, line);
		if (result.exitCode !== 0) failed += result.stderr.toString();
	}
	return failed;
}

/** A buyer: their own empty origin and a directory to clone into. */
function buyer(name: string): { dir: string; origin: string } {
	const dir = join(root, name);
	const origin = join(root, `${name}.git`);
	mkdirSync(dir);
	run(root, `git init --quiet --bare --initial-branch=main ${origin}`);
	return { dir, origin };
}

/** A buyer who started from a downloaded archive of v1.0.0: their own history, no kit remote. */
function archiveBuyer(name: string): { repo: string; origin: string } {
	const { dir, origin } = buyer(name);
	run(root, `git -C ${seller} archive v1.0.0 | tar -x -C ${dir}`);
	run(dir, `git init -q --initial-branch=main && git add -A && git commit -qm "From the archive"`);
	run(dir, `git remote add origin file://${origin} && git push -q -u origin main`);
	return { repo: dir, origin };
}

/** The page's prose with its line breaks folded, for a sentence that may wrap anywhere. */
function prose(): string {
	return page.replace(/\s+/g, ' ');
}

/** Steps 1 and 2 of "Then, in order", after the caller resolved the conflict. */
function finishMerge(repo: string) {
	expect(page).toContain('`bun install`');
	run(repo, 'bun install && git add -u');
	if (sh(repo, 'git rev-parse -q --verify MERGE_HEAD').exitCode === 0)
		run(repo, 'git commit -q --no-edit');
	run(repo, 'git diff main -- .env.example');
}

/** Keeps the buyer's side of every conflict hunk, as a person resolving by hand would here. */
function keepOurs(path: string) {
	const text = readFileSync(path, 'utf8');
	writeFileSync(
		path,
		text.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/g, '$1'),
	);
}

/** Step 6's push, which only a fork with a `kit-renamed` branch has. */
function pushSnapshot(repo: string) {
	expect(page).toContain('`git push origin kit-renamed`');
	run(repo, 'git push -q origin kit-renamed');
	expect(run(repo, 'git ls-remote origin kit-renamed')).toContain(
		run(repo, 'git rev-parse kit-renamed'),
	);
}

/** "When an upgrade goes wrong", each command in the state the page gives it for. */
function walkAway(repo: string) {
	const section = page.split('## When an upgrade goes wrong')[1] ?? '';
	const back = 'git branch -f kit-renamed "$(git merge-base main kit-renamed)"';
	for (const command of ['git merge --abort', 'git reset --hard', 'git switch main', back])
		expect(section).toContain(`\`${command}\``);
	expect(section).toContain('`git branch -D upgrade/v1.1.0`');
	if (sh(repo, 'git rev-parse -q --verify MERGE_HEAD').exitCode === 0)
		run(repo, 'git merge --abort');
	if (run(repo, 'git branch --show-current') === 'kit-renamed') run(repo, 'git reset --hard');
	run(repo, 'git switch main');
	if (sh(repo, 'git rev-parse -q --verify upgrade/v1.1.0').exitCode === 0)
		run(repo, 'git branch -D upgrade/v1.1.0');
	run(repo, back);
}

function edits(repo: string) {
	const app = join(repo, 'src/app.ts');
	const text = readFileSync(app, 'utf8');
	writeFileSync(app, text.replace("'Hello'", "'Howdy'").replace("'Goodbye'", "'See you'"));
	write(join(repo, 'product.md'), '# Our product\n');
	// `version` is the product's own: the buyer releases on it, and a kit release never touches it.
	const manifest = join(repo, 'package.json');
	const before = readFileSync(manifest, 'utf8');
	writeFileSync(manifest, before.replace('"version": "0.1.0"', '"version": "0.2.0"'));
	run(repo, 'git add -A && git commit -qm "Make it ours"');
}

/** The buyer's `version` and the release's `kitVersion`, both kept by the merge. */
function expectVersions(repo: string) {
	const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
	expect(manifest.version).toBe('0.2.0');
	expect(manifest.kitVersion).toBe('1.1.0');
}

function releaseNext() {
	const app = join(seller, 'src/app.ts');
	const text = readFileSync(app, 'utf8')
		.replace("import { db } from '@sk/db';", "import { db, sql } from '@sk/db';")
		.replace("product = 'Sourkit';", "product = 'Sourkit Pro';")
		.replace("'Hello'", "'Hi'");
	writeFileSync(app, text);
	const readme = readFileSync(join(seller, 'README.md'), 'utf8');
	writeFileSync(
		join(seller, 'README.md'),
		readme.replace('Sourkit is a kit.', 'Sourkit is a starter kit.'),
	);
	write(join(seller, 'src/worker.ts'), "export const worker = 'sourkit-worker';\n");
	run(seller, 'git rm -q old.txt');
	// A release moves only `kitVersion`; `version` stays the placeholder every product starts from.
	const manifest = readFileSync(join(seller, 'package.json'), 'utf8');
	writeFileSync(
		join(seller, 'package.json'),
		manifest.replace('"kitVersion": "1.0.0"', '"kitVersion": "1.1.0"'),
	);
	run(seller, 'git add -A && git commit -qm "1.1.0" && git tag -a v1.1.0 -m 1.1.0');
	write(join(seller, 'unreleased.txt'), 'work in progress\n');
	run(seller, 'git add -A && git commit -qm "Unreleased" && git push -q origin main --tags');
}

/** The tree a clean rename of the tag produces, for comparison with a snapshot. */
function renamedTree(tag: string): string {
	const scratch = join(root, `fresh-${tag}`);
	run(root, `git clone -q file://${upstream} ${scratch}`);
	return run(
		scratch,
		`git reset -q --hard ${tag} && ${RENAME} >/dev/null && git add -u && git write-tree`,
	);
}

function expectUpgraded(repo: string, base: string) {
	const app = readFileSync(join(repo, 'src/app.ts'), 'utf8');
	expect(app).toContain("import { db, sql } from '@acme/db';");
	expect(app).toContain("product = 'Acme Pro';");
	expect(app).toContain("container = 'acme-api';");
	expect(app).toContain("'Howdy'");
	expect(app).toContain("'See you'");
	expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('Acme is a starter kit.');
	expect(readFileSync(join(repo, 'src/worker.ts'), 'utf8')).toContain("'acme-worker'");
	expect(existsSync(join(repo, 'old.txt'))).toBe(false);
	expect(existsSync(join(repo, 'unreleased.txt'))).toBe(false);
	expectVersions(repo);
	expect(run(repo, `git diff --name-only ${base} main`).split('\n')).toEqual([
		'package.json',
		'product.md',
		'src/app.ts',
	]);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'starterdough-upgrade-test-'));
	upstream = join(root, 'kit.git');
	seller = join(root, 'seller');
	run(root, `git init --quiet --bare --initial-branch=main ${upstream}`);
	run(root, `git clone --quiet ${upstream} ${seller}`);
	write(
		join(seller, 'package.json'),
		'{\n\t"name": "sourkit",\n\t"private": true,\n\t"version": "0.1.0",\n' +
			'\t"description": "A miniature kit.",\n\t"packageManager": "bun@1.4.2",\n' +
			'\t"kitVersion": "1.0.0",\n\t"scripts": {\n' +
			'\t\t"rename": "bun scripts/rename.ts",\n\t\t"lint:fix": "bun -e 0"\n\t}\n}\n',
	);
	write(join(seller, '.gitignore'), 'node_modules/\n');
	write(
		join(seller, 'apps/native/src-tauri/tauri.conf.json'),
		'{ "productName": "Sourkit", "identifier": "dev.sourkit.desktop" }\n',
	);
	write(join(seller, 'packages/tsconfig/package.json'), '{ "name": "@sk/tsconfig" }\n');
	write(
		join(seller, 'scripts/rename.ts'),
		readFileSync(join(repoRoot, 'scripts/rename.ts'), 'utf8'),
	);
	// Unchanged lines between the ones a release or the buyer touches keep the hunks apart.
	write(
		join(seller, 'src/app.ts'),
		[
			"import { db } from '@sk/db';",
			'',
			'export const database = db;',
			"export const product = 'Sourkit';",
			"export const container = 'sourkit-api';",
			"export const bundle = 'dev.sourkit.desktop';",
			'',
			"export const greeting = 'Hello';",
			'',
			'export const separator = 1;',
			'',
			"export const farewell = 'Goodbye';",
			'',
		].join('\n'),
	);
	write(
		join(seller, 'README.md'),
		'# Sourkit\n\nSourkit is a kit.\n\nRun it with `sourkit dev`.\n',
	);
	write(join(seller, 'old.txt'), 'removed in 1.1.0\n');
	run(seller, 'git add -A && git commit -qm "1.0.0" && git tag -a v1.0.0 -m 1.0.0');
	write(join(seller, 'wip.txt'), 'ahead of the release\n');
	run(seller, 'git add -A && git commit -qm "Unreleased" && git push -q origin main --tags');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('UPGRADING.md', () => {
	it(
		'carries a renamed fork from one release tag to the next with only the real conflict',
		() => {
			const { dir, origin } = buyer('renamed');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			expect(existsSync(join(repo, 'wip.txt'))).toBe(false);
			follow(block('git switch --no-track -c kit-renamed', '-s ours'), repo, origin);
			edits(repo);

			releaseNext();
			follow(block('git restore --source='), repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			keepOurs(join(repo, 'src/app.ts'));
			run(repo, 'git add src/app.ts');
			finishMerge(repo);
			follow(block('git merge upgrade/v1.1.0'), repo, origin);
			pushSnapshot(repo);

			expectUpgraded(repo, 'kit-renamed');
			expect(run(repo, 'git rev-parse kit-renamed^{tree}')).toBe(renamedTree('v1.1.0'));
			expect(run(repo, 'git ls-remote origin main')).toContain(run(repo, 'git rev-parse main'));
		},
		TIMEOUT,
	);

	it(
		'adopts a main that was renamed in place, then upgrades it the same way',
		() => {
			const { dir, origin } = buyer('in-place');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			run(repo, `${RENAME} >/dev/null && bun install && git commit -qam "Rename to Acme"`);
			edits(repo);
			const before = run(repo, 'git rev-parse HEAD^{tree}');
			follow(block('git merge -s ours kit-renamed'), repo, origin);
			expect(run(repo, 'git rev-parse HEAD^{tree}')).toBe(before);

			releaseNext();
			follow(block('git restore --source='), repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			keepOurs(join(repo, 'src/app.ts'));
			run(repo, 'git add src/app.ts');
			finishMerge(repo);
			follow(block('git merge upgrade/v1.1.0'), repo, origin);
			pushSnapshot(repo);

			expectUpgraded(repo, 'kit-renamed');
		},
		TIMEOUT,
	);

	it(
		'pushes nothing when the release it starts from has no tag yet, and resumes once it has',
		() => {
			run(root, `git -C ${upstream} tag -d v1.0.0`);
			const { dir, origin } = buyer('untagged');
			const start = block('git clone --no-tags');
			// Pasted whole, so every line after the failing one runs too.
			expect(paste(start, dir, origin)).toContain('unknown revision');
			// Not the kit's work in progress on main, nor anything else.
			expect(run(root, `git -C ${origin} for-each-ref`)).toBe('');

			// Re-pasting the block would stop on the existing clone and remotes; the page says what to
			// run instead, in the clone the first paste left behind.
			expect(prose()).toContain(
				"Once the tag is published, run `git fetch kit` and then the block's last line again, in the same clone.",
			);
			run(seller, 'git push -q origin v1.0.0');
			const repo = join(dir, (start.find((line) => line.startsWith('cd ')) ?? '').slice(3));
			follow(['git fetch kit', start.at(-1) ?? ''], repo, origin);
			expect(run(repo, 'git ls-remote origin main')).toContain(
				run(seller, 'git rev-parse v1.0.0^{commit}'),
			);
		},
		TIMEOUT,
	);

	it(
		'adopts a downloaded archive renamed in place, then upgrades it the same way',
		() => {
			const { repo, origin } = archiveBuyer('archive-renamed');
			run(repo, `${RENAME} >/dev/null && bun install && git commit -qam "Rename to Acme"`);
			edits(repo);
			const before = run(repo, 'git rev-parse HEAD^{tree}');
			follow(block('git remote add kit'), repo, origin);
			const flag = '--allow-unrelated-histories';
			expect(prose()).toContain(`\`${flag}\` added to its \`git merge -s ours\` line`);
			const bootstrap = block('git merge -s ours kit-renamed').map((line) =>
				line.replace('git merge -s ours', `git merge -s ours ${flag}`),
			);
			follow(bootstrap, repo, origin);
			expect(run(repo, 'git rev-parse HEAD^{tree}')).toBe(before);

			releaseNext();
			follow(block('git restore --source='), repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			keepOurs(join(repo, 'src/app.ts'));
			run(repo, 'git add src/app.ts');
			finishMerge(repo);
			follow(block('git merge upgrade/v1.1.0'), repo, origin);
			pushSnapshot(repo);

			expectUpgraded(repo, 'kit-renamed');
		},
		TIMEOUT,
	);

	it(
		'adopts a downloaded archive that kept the name, then merges release tags',
		() => {
			const { repo, origin } = archiveBuyer('archive-kept');
			edits(repo);
			const before = run(repo, 'git rev-parse HEAD^{tree}');
			follow(block('git remote add kit'), repo, origin);
			const adopt = 'git merge -s ours --allow-unrelated-histories kit/v1.0.0';
			expect(page).toContain(`\`${adopt}\``);
			run(repo, adopt);
			expect(run(repo, 'git rev-parse HEAD^{tree}')).toBe(before);

			releaseNext();
			follow(block('git merge kit/v1.1.0'), repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			keepOurs(join(repo, 'src/app.ts'));
			run(repo, 'git add src/app.ts');
			finishMerge(repo);
			follow(block('git merge upgrade/v1.1.0'), repo, origin);

			const app = readFileSync(join(repo, 'src/app.ts'), 'utf8');
			expect(app).toContain("import { db, sql } from '@sk/db';");
			expect(app).toContain("'Howdy'");
			expect(existsSync(join(repo, 'old.txt'))).toBe(false);
			expect(existsSync(join(repo, 'unreleased.txt'))).toBe(false);
			expectVersions(repo);
			expect(run(repo, 'git diff --name-only kit/v1.1.0 main').split('\n')).toEqual([
				'package.json',
				'product.md',
				'src/app.ts',
			]);
		},
		TIMEOUT,
	);

	it(
		'merges release tags straight into a fork that kept the name',
		() => {
			const { dir, origin } = buyer('kept');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			edits(repo);

			releaseNext();
			follow(block('git merge kit/v1.1.0'), repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			keepOurs(join(repo, 'src/app.ts'));
			run(repo, 'git add src/app.ts');
			finishMerge(repo);
			follow(block('git merge upgrade/v1.1.0'), repo, origin);

			const app = readFileSync(join(repo, 'src/app.ts'), 'utf8');
			expect(app).toContain("import { db, sql } from '@sk/db';");
			expect(app).toContain("'Howdy'");
			expect(existsSync(join(repo, 'unreleased.txt'))).toBe(false);
			expectVersions(repo);
			expect(run(repo, 'git tag')).toBe('kit/v1.0.0\nkit/v1.1.0');
			expect(run(repo, 'git ls-remote origin main')).toContain(run(repo, 'git rev-parse main'));
		},
		TIMEOUT,
	);

	it(
		'walks away from a snapshot that never got its commit and from an open merge',
		() => {
			const { dir, origin } = buyer('walk-away');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			follow(block('git switch --no-track -c kit-renamed', '-s ours'), repo, origin);
			edits(repo);
			const before = run(repo, 'git rev-parse main kit-renamed');

			releaseNext();
			const upgrade = block('git restore --source=');
			// A hook, or `bun install` without a network, fails before the snapshot's commit.
			follow(
				upgrade.slice(
					0,
					upgrade.findIndex((line) => line.startsWith('git commit')),
				),
				repo,
				origin,
			);
			expect(sh(repo, 'git switch main').exitCode).not.toBe(0);
			walkAway(repo);
			expect(run(repo, 'git rev-parse main kit-renamed')).toBe(before);

			// The merge stops on its conflict and is abandoned, twice over by someone unsure it worked.
			follow(upgrade, repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
			walkAway(repo);
			walkAway(repo);
			expect(run(repo, 'git rev-parse main kit-renamed')).toBe(before);
			expect(run(repo, 'git status --porcelain')).toBe('');

			follow(upgrade, repo, origin);
			expect(conflicts(repo)).toEqual(['src/app.ts']);
		},
		TIMEOUT,
	);

	it(
		'creates kit-renamed without an upstream, even from a branch',
		() => {
			const creations = page
				.split('\n')
				.filter((line) => /\bgit (switch|checkout)\b.*\s-[bBcC] kit-renamed\b/.test(line));
			expect(creations.length).toBeGreaterThan(0);
			for (const line of creations) expect(line).toContain('--no-track');

			// From a tag, as the page does, no branch gets an upstream anyway; from a branch, such as
			// the `kit/main` an older clone starts from, it would, and `git pull` there would merge it.
			const { dir, origin } = buyer('no-track');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			run(repo, (creations[0] ?? '').trim().replace('kit/v1.0.0', 'kit/main'));
			expect(sh(repo, 'git config branch.kit-renamed.merge').exitCode).not.toBe(0);
		},
		TIMEOUT,
	);

	// A script the page names but the manifest lacks fails on the buyer's machine, in the middle of an
	// upgrade. The free edition's manifest drops the paid-only ones, so the page must too.
	it('names only scripts the root package.json has', () => {
		const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		const scripts = Object.keys(manifest.scripts as Record<string, string>);
		// Named as the script 1.0.0 removed.
		const removed = ['db:push'];
		const named = [...page.matchAll(/\bbun run ([\w:-]+)/g)]
			.map((match) => match[1] ?? '')
			.filter((name) => !name.startsWith('-'));
		expect(named.length).toBeGreaterThan(0);
		const missing = named.filter((name) => !scripts.includes(name) && !removed.includes(name));
		expect([...new Set(missing)]).toEqual([]);
	});

	// The page and the changelog reach a renamed fork as they are (`rename` keeps both verbatim), but
	// `rename` rewrote the old default checkout path in its provision.sh and deploy.yml to
	// `/opt/<slug>`. Naming `/opt/starterdough` as that default sent its first 1.1.0 deploy to a path
	// with no checkout.
	it("gives a renamed fork the DEPLOY_PATH its own rename chose, not the kit's", () => {
		const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
		const release = changelog.slice(0, changelog.indexOf('\n## [1.0.0]'));
		const heading = '\n### Deploys and operations (1.1.0)\n';
		const deploys = page.slice(page.indexOf(heading)).split('\n### ')[1] ?? '';
		expect(deploys).toStartWith('Deploys and operations (1.1.0)');
		for (const text of [deploys, release]) {
			expect(text).toContain('`/opt/<your slug>`');
			expect(text).not.toMatch(/DEPLOY_PATH` no longer defaults to `\/opt\/starterdough`/);
		}
	});

	// A failed deploy prints migrate.ts's message and nothing else, so the section it names must be
	// there to find under that heading.
	it('points failed migrations at a section that exists', () => {
		const migrate = readFileSync(join(repoRoot, 'packages/db/src/migrate.ts'), 'utf8');
		const named = [...migrate.matchAll(/UPGRADING\.md, "([^"]+)"/g)].map((match) => match[1]);
		expect(named.length).toBeGreaterThan(0);
		for (const section of named) expect(page).toContain(`\n## ${section}\n`);
	});
});

describe('UPGRADING.md under a git hook', () => {
	// What git exports to lefthook's pre-push hook, and so to `bun run verify`, in a linked worktree.
	const keys = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
	// Under a real hook these are already set; the files after this one get them back unchanged.
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	let host: string;
	let before: string;
	const state = () => run(host, 'git for-each-ref && git status --porcelain --untracked-files=all');

	beforeAll(() => {
		host = mkdtempSync(join(tmpdir(), 'starterdough-upgrade-host-'));
		run(host, 'git init -q --initial-branch=main && git commit -q --allow-empty -m "Host"');
		before = state();
		Object.assign(process.env, {
			GIT_DIR: join(host, '.git'),
			GIT_INDEX_FILE: join(host, '.git', 'index'),
			GIT_WORK_TREE: host,
		});
	});

	afterAll(() => {
		for (const key of keys) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(host, { recursive: true, force: true });
	});

	it(
		'leaves the repository the hook runs in alone',
		() => {
			const { dir, origin } = buyer('hooked');
			const repo = follow(block('git clone --no-tags'), dir, origin);
			edits(repo);
			releaseNext();
			follow(block('git merge kit/v1.1.0'), repo, origin);

			expect(conflicts(repo)).toEqual(['src/app.ts']);
			expect(state()).toBe(before);
		},
		TIMEOUT,
	);
});
