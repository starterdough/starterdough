/**
 * `bun run rename` against a miniature kit: the rules a whole-repository substitution cannot get
 * right by itself. Git only ever touches the fixture (see upgrading.test.ts for why every inherited
 * `GIT_*` variable is dropped).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const rename = readFileSync(resolve(import.meta.dir, 'rename.ts'), 'utf8');
let repo: string;

function env(): Record<string, string | undefined> {
	const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
	return {
		...Object.fromEntries(inherited),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		LEFTHOOK: '0',
	};
}

function run(argv: string[]): string {
	const result = Bun.spawnSync(argv, { cwd: repo, env: env(), stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(`${argv.join(' ')}\n${result.stderr.toString()}`);
	return result.stdout.toString();
}

function write(path: string, text: string) {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
}

const read = (path: string) => readFileSync(join(repo, path), 'utf8');

function renameTo(name: string, slug: string, scope: string): string {
	return run([
		process.execPath,
		'scripts/rename.ts',
		'--name',
		name,
		'--slug',
		slug,
		'--identifier',
		`com.${slug.replaceAll('-', '')}.desktop`,
		'--scope',
		scope,
		'--write',
	]);
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'starterdough-rename-test-'));
	write('package.json', '{\n\t"name": "sourkit",\n\t"version": "1.0.0"\n}\n');
	write(
		'apps/native/src-tauri/tauri.conf.json',
		'{ "productName": "Sourkit", "identifier": "dev.sourkit.app" }\n',
	);
	write('packages/tsconfig/package.json', '{ "name": "@sk/tsconfig" }\n');
	write('scripts/rename.ts', rename);
	write(
		'apps/api/package.json',
		[
			'{',
			'\t"name": "@sk/api",',
			'\t"dependencies": {',
			'\t\t"@hono/otel": "catalog:",',
			'\t\t"@orpc/server": "catalog:",',
			'\t\t"@sk/db": "workspace:*",',
			'\t\t"zod": "catalog:"',
			'\t},',
			'\t"devDependencies": {',
			'\t\t"@sk/tsconfig": "workspace:*",',
			'\t\t"@types/bun": "catalog:"',
			'\t}',
			'}',
			'',
		].join('\n'),
	);
	write(
		'infra/deploy.sh',
		[
			'state_dir="$SOURKIT_STATE_DIR" fallback="$HOME/.local/state/sourkit"',
			'export SOURKIT_OPERATION_LOCK_HELD=1',
			'echo SOURKITS XSOURKIT_KEEP',
			'',
		].join('\n'),
	);
	run(['git', 'init', '--quiet', '--initial-branch=main']);
	run(['git', 'add', '-A']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('bun run rename', () => {
	it('renames environment variable prefixes, turning a dash into an underscore', () => {
		renameTo('My App', 'my-app', '@myapp');
		expect(read('infra/deploy.sh')).toBe(
			[
				'state_dir="$MY_APP_STATE_DIR" fallback="$HOME/.local/state/my-app"',
				'export MY_APP_OPERATION_LOCK_HELD=1',
				'echo SOURKITS XSOURKIT_KEEP',
				'',
			].join('\n'),
		);
	});

	it('leaves each dependency map in the order bun add keeps it', () => {
		renameTo('Acme', 'acme', '@acme');
		const manifest = read('apps/api/package.json');
		expect(manifest).toContain(
			[
				'\t"dependencies": {',
				'\t\t"@acme/db": "workspace:*",',
				'\t\t"@hono/otel": "catalog:",',
				'\t\t"@orpc/server": "catalog:",',
				'\t\t"zod": "catalog:"',
				'\t},',
			].join('\n'),
		);
		expect(manifest).toContain(
			'\t"devDependencies": {\n\t\t"@acme/tsconfig": "workspace:*",\n\t\t"@types/bun": "catalog:"\n\t}',
		);
		expect(JSON.parse(manifest).name).toBe('@acme/api');
	});

	it('runs again from the renamed values', () => {
		renameTo('Acme', 'acme', '@acme');
		run(['git', 'add', '-A']);
		renameTo('Lumen', 'lumen', '@lumen');
		expect(read('infra/deploy.sh')).toContain(
			'"$LUMEN_STATE_DIR" fallback="$HOME/.local/state/lumen"',
		);
		expect(read('apps/api/package.json')).toContain('"@lumen/db": "workspace:*"');
	});

	it('keeps variable names and prose apart for a product named in capitals', () => {
		renameTo('ACME', 'acme', '@acme');
		write('NOTES.md', 'ACME keeps ACME_STATE_DIR.\n');
		run(['git', 'add', '-A']);
		renameTo('Lumen', 'lumen', '@lumen');
		expect(read('NOTES.md')).toBe('Lumen keeps LUMEN_STATE_DIR.\n');
		expect(read('infra/deploy.sh')).toContain('"$LUMEN_STATE_DIR"');
	});

	it('keeps the kit’s own name where a page says what the product is built on', () => {
		write('package.json', '{\n\t"name": "starterdough",\n\t"version": "1.0.0"\n}\n');
		write(
			'apps/native/src-tauri/tauri.conf.json',
			'{ "productName": "Starterdough", "identifier": "dev.starterdough.native" }\n',
		);
		write(
			'GUIDE.md',
			'Starterdough runs here. This repo is [Name], built on the Starterdough kit.\n',
		);
		run(['git', 'add', '-A']);
		renameTo('Acme', 'acme', '@acme');
		expect(read('GUIDE.md')).toBe(
			'Acme runs here. This repo is [Name], built on the Starterdough kit.\n',
		);
	});
});
