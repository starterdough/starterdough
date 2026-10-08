import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { runDoctor } from './doctor';
import {
	applySetup,
	fillRow,
	formatSetupReport,
	planSetup,
	type SetupDependencies,
	type SetupPlan,
} from './setup';

const repoRoot = resolve(import.meta.dir, '..');

/** Every template setup reads, as the repository ships it. */
const TEMPLATES = [
	'.env.example',
	'apps/web/.env.example',
	'apps/site/.env.example',
	'apps/docs/.env.example',
];

let root: string;
let counter: number;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'starterdough-setup-'));
	counter = 0;
	for (const template of TEMPLATES) {
		await mkdir(dirname(join(root, template)), { recursive: true });
		await copyFile(join(repoRoot, template), join(root, template));
	}
});

afterEach(async () => {
	await rm(root, { force: true, recursive: true });
});

const dependencies: SetupDependencies = {
	async exists(path) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	},
	read: (path) => readFile(path, 'utf8'),
	// Distinct, recognisable values, so a test can tell which row received which one.
	generate(bytes) {
		counter += 1;
		return String(counter).padStart(2, '0').repeat(bytes);
	},
};

async function setup(): Promise<SetupPlan> {
	const plan = await planSetup(root, dependencies);
	await applySetup(root, plan);
	return plan;
}

async function env(path: string): Promise<Record<string, string | undefined>> {
	return parseEnv(await readFile(join(root, path), 'utf8'));
}

describe('bun run setup', () => {
	it('creates every environment file from its template, ready to run', async () => {
		const plan = await setup();
		expect(plan.changes.map((change) => [change.path, change.created])).toEqual(
			TEMPLATES.map((template) => [template.replace(/\.example$/, ''), true]),
		);
		expect(plan.problems).toEqual([]);

		const rootEnv = await env('.env');
		expect(rootEnv.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
		expect((await env('apps/site/.env')).SITE_URL).toBe('http://localhost:4321');
		expect((await env('apps/docs/.env')).SITE_URL).toBe('http://localhost:4322');

		// Apart from the filled rows, each file is its template, comments included.
		for (const change of plan.changes) {
			const template = await readFile(join(root, `${change.path}.example`), 'utf8');
			const filled = new Set(change.filled.map(({ name }) => name));
			const strip = (text: string) =>
				text.split('\n').filter((line) => !filled.has(line.split('=')[0] ?? ''));
			expect(strip(await readFile(join(root, change.path), 'utf8'))).toEqual(strip(template));
		}
	});

	it('creates the files readable by their owner only', async () => {
		if (process.platform === 'win32') return;
		await setup();
		expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
	});

	it('changes nothing on a second run', async () => {
		await setup();
		const before = await Promise.all(
			TEMPLATES.map((template) => readFile(join(root, template.replace(/\.example$/, '')))),
		);
		const again = await setup();
		expect(again.changes).toEqual([]);
		expect(again.unchanged).toHaveLength(TEMPLATES.length);
		const after = await Promise.all(
			TEMPLATES.map((template) => readFile(join(root, template.replace(/\.example$/, '')))),
		);
		expect(after).toEqual(before);
	});

	it('completes an existing file without replacing anything that is set', async () => {
		await writeFile(
			join(root, '.env'),
			'BETTER_AUTH_SECRET=my-own-secret-that-is-long-enough-to-pass\r\nDATABASE_URL=postgres://me@db/app\r\n',
		);
		await writeFile(join(root, 'apps/site/.env'), 'SITE_URL=https://www.customer.test\n');
		await writeFile(join(root, 'apps/docs/.env'), 'export SITE_URL=""\nPUBLIC_API_URL=x');

		const plan = await setup();
		expect(await readFile(join(root, '.env'), 'utf8')).toStartWith(
			'BETTER_AUTH_SECRET=my-own-secret-that-is-long-enough-to-pass\r\nDATABASE_URL=postgres://me@db/app\r\n',
		);
		expect(plan.changes.find((change) => change.path === '.env')?.filled ?? []).not.toContainEqual(
			expect.objectContaining({ name: 'BETTER_AUTH_SECRET' }),
		);
		expect(await readFile(join(root, 'apps/site/.env'), 'utf8')).toBe(
			'SITE_URL=https://www.customer.test\n',
		);
		expect(plan.unchanged).toContain('apps/site/.env');
		expect(await readFile(join(root, 'apps/docs/.env'), 'utf8')).toBe(
			'export SITE_URL=http://localhost:4322\nPUBLIC_API_URL=x',
		);
	});

	it('fills the last assignment of a row, or appends an absent one with the file’s line endings', () => {
		expect(fillRow('A=\nA=\n', 'A', '1')).toBe('A=\nA=1\n');
		expect(fillRow('A = \r\nB=2\r\n', 'A', '1')).toBe('A =1\r\nB=2\r\n');
		expect(fillRow('# A=\nB=2', 'A', '1')).toBe('# A=\nB=2\nA=1\n');
		expect(fillRow('B=2\r\n', 'A', '1')).toBe('B=2\r\nA=1\r\n');
		expect(fillRow('', 'A', '1')).toBe('A=1\n');
	});

	it('skips a file whose app was removed instead of failing', async () => {
		await rm(join(root, 'apps/docs'), { recursive: true });
		const plan = await setup();
		expect(plan.skipped).toEqual(['apps/docs/.env']);
		expect(plan.problems).toEqual([]);
		expect(formatSetupReport(plan)).toMatch(/apps\/docs\/\.env +skipped/);
	});

	it('never prints a generated value', async () => {
		const report = formatSetupReport(await setup());
		const rootEnv = await env('.env');
		expect(report).toContain('BETTER_AUTH_SECRET (generated)');
		expect(report).not.toContain(rootEnv.BETTER_AUTH_SECRET ?? 'unset');
	});

	it('names the way around Docker next to the Docker steps', async () => {
		expect(formatSetupReport(await setup())).toContain(
			'No Docker? Point DATABASE_URL at your own Postgres 17',
		);
	});

	it('leaves files the doctor accepts for the app and a full local build', async () => {
		await setup();
		await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
		for (const path of ['bun.lock', 'node_modules/.bin/turbo']) {
			await writeFile(join(root, path), '');
		}
		for (const path of ['zod', 'hono', 'astro', '@sveltejs/kit']) {
			await mkdir(join(root, 'node_modules', path), { recursive: true });
		}
		const report = await runDoctor(
			{ build: true, database: 'external', rootDir: root },
			{
				bunVersion: '1.4.2',
				env: {},
				exists: dependencies.exists,
				nodeVersion: async () => null,
				read: dependencies.read,
				run: async () => false,
			},
		);
		expect(report.checks.filter((check) => !check.ok)).toEqual([]);
	});
});
