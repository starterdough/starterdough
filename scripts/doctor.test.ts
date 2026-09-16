import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DoctorDependencies, formatDoctorReport, runDoctor } from './doctor';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'starterdough-doctor-'));
	await Promise.all([
		mkdir(join(root, 'node_modules/.bin'), { recursive: true }),
		mkdir(join(root, 'node_modules/zod'), { recursive: true }),
		mkdir(join(root, 'node_modules/hono'), { recursive: true }),
		mkdir(join(root, 'node_modules/astro'), { recursive: true }),
		mkdir(join(root, 'node_modules/@sveltejs/kit'), { recursive: true }),
		mkdir(join(root, 'apps/web'), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(root, 'bun.lock'), ''),
		writeFile(join(root, 'node_modules/.bin/turbo'), ''),
		writeFile(join(root, 'node_modules/zod/package.json'), '{}'),
		writeFile(
			join(root, '.env'),
			[
				'NODE_ENV=development',
				'DATABASE_URL=postgres://starterdough:starterdough@localhost:5433/starterdough',
				`BETTER_AUTH_SECRET=${'a'.repeat(48)}`,
			].join('\n'),
		),
		writeFile(join(root, 'apps/web/.env'), 'PUBLIC_API_URL=http://localhost:3000\n'),
	]);
});

afterEach(async () => {
	await rm(root, { force: true, recursive: true });
});

function dependencies(
	commands: Record<string, boolean> = {
		'docker --version': true,
		'docker compose version': true,
		'docker info --format {{.ServerVersion}}': true,
	},
	env: Record<string, string | undefined> = {},
): DoctorDependencies & { calls: string[] } {
	const calls: string[] = [];
	return {
		bunVersion: '1.4.2',
		calls,
		env,
		async exists(path) {
			try {
				await stat(path);
				return true;
			} catch {
				return false;
			}
		},
		async read(path) {
			return Bun.file(path).text();
		},
		async run(argv) {
			const command = argv.join(' ');
			calls.push(command);
			return commands[command] ?? false;
		},
	};
}

async function doctor(
	options: Partial<{ build: boolean; database: 'docker' | 'external' }> = {},
	deps = dependencies(),
) {
	return runDoctor(
		{
			build: options.build ?? false,
			database: options.database ?? 'docker',
			rootDir: root,
		},
		deps,
	);
}

describe('Starterdough doctor', () => {
	it('reports an absent Compose plugin separately from the Docker CLI and daemon', async () => {
		const report = await doctor(
			{},
			dependencies({
				'docker --version': true,
				'docker compose version': false,
				'docker info --format {{.ServerVersion}}': true,
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Docker CLI')?.ok).toBe(true);
		expect(report.checks.find((check) => check.name === 'Docker Compose plugin')?.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Docker daemon')?.ok).toBe(true);
	});

	it('reports an unavailable daemon after finding Docker and Compose', async () => {
		const report = await doctor(
			{},
			dependencies({
				'docker --version': true,
				'docker compose version': true,
				'docker info --format {{.ServerVersion}}': false,
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Docker daemon')).toMatchObject({
			ok: false,
		});
	});

	it('skips every Docker command when an existing PostgreSQL is explicit', async () => {
		const deps = dependencies({});
		const report = await doctor({ database: 'external' }, deps);
		expect(report.ok).toBe(true);
		expect(deps.calls).toEqual([]);
		expect(report.checks.find((check) => check.name === 'Database path')?.detail).toContain(
			'Docker checks are skipped',
		);
	});

	it('does not expose credentials from invalid configuration', async () => {
		const secret = 'never-print-this-password';
		await writeFile(
			join(root, '.env'),
			`DATABASE_URL=postgres://starterdough:${secret}@[broken\nBETTER_AUTH_SECRET=${'s'.repeat(48)}\n`,
		);
		const report = await doctor({ database: 'external' });
		const output = formatDoctorReport(report);
		expect(report.ok).toBe(false);
		expect(output).not.toContain(secret);
		expect(output).toContain('DATABASE_URL');
	});

	it('names missing setup files without printing their contents', async () => {
		await Promise.all([rm(join(root, '.env')), rm(join(root, 'apps/web/.env'))]);
		const report = await doctor({ database: 'external' });
		expect(report.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Root environment')?.detail).toContain(
			'missing .env',
		);
		expect(report.checks.find((check) => check.name === 'Web app environment')?.detail).toContain(
			'missing apps/web/.env',
		);
	});

	it('catches local API and Docker database port drift', async () => {
		await writeFile(
			join(root, '.env'),
			[
				'NODE_ENV=development',
				'PORT=3001',
				'API_URL=http://localhost:3000',
				'POSTGRES_PORT=5440',
				'DATABASE_URL=postgres://starterdough:starterdough@localhost:5433/starterdough',
				`BETTER_AUTH_SECRET=${'a'.repeat(48)}`,
			].join('\n'),
		);
		const report = await doctor();
		const detail = report.checks.find((check) => check.name === 'Root environment')?.detail;
		expect(detail).toContain('API_URL port must match PORT');
		expect(detail).toContain('DATABASE_URL port must match POSTGRES_PORT');
	});

	it('adds canonical site origins only for a full build', async () => {
		expect((await doctor({ database: 'external' })).ok).toBe(true);

		const missing = await doctor({ build: true, database: 'external' });
		expect(missing.ok).toBe(false);
		expect(missing.checks.find((check) => check.name === 'Marketing site build')?.detail).toBe(
			'SITE_URL is missing',
		);
		expect(missing.checks.find((check) => check.name === 'Documentation build')?.detail).toBe(
			'SITE_URL is missing',
		);

		await Promise.all([
			mkdir(join(root, 'apps/site'), { recursive: true }),
			mkdir(join(root, 'apps/docs'), { recursive: true }),
		]);
		await writeFile(
			join(root, 'apps/site/.env.production'),
			'SITE_URL=https://ignored.tested.invalid\nPUBLIC_APP_URL=garbage\n',
		);
		const productionOnly = await doctor({ build: true, database: 'external' });
		const siteDetail = productionOnly.checks.find(
			(check) => check.name === 'Marketing site build',
		)?.detail;
		expect(siteDetail).toContain('SITE_URL is missing');
		expect(siteDetail).toContain('PUBLIC_APP_URL must be an absolute http(s) URL');

		await Promise.all([
			writeFile(
				join(root, 'apps/site/.env'),
				'SITE_URL=https://product.tested.invalid\nPUBLIC_API_URL=https://api.tested.invalid\n',
			),
			writeFile(join(root, 'apps/site/.env.local'), 'SITE_URL=\n'),
			writeFile(
				join(root, 'apps/site/.env.production'),
				'SITE_URL=https://ignored.tested.invalid\nPUBLIC_APP_URL=https://app.tested.invalid\n',
			),
			writeFile(
				join(root, 'apps/docs/.env'),
				'SITE_URL=https://docs.tested.invalid\nPUBLIC_API_URL=https://api.tested.invalid\n',
			),
		]);
		expect((await doctor({ build: true, database: 'external' })).ok).toBe(true);
	});

	it('fails on an old Bun and incomplete dependency install', async () => {
		await rm(join(root, 'node_modules/.bin/turbo'));
		const deps = dependencies();
		deps.bunVersion = '1.3.9';
		const report = await doctor({}, deps);
		expect(report.checks.find((check) => check.name === 'Bun runtime')?.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Dependencies')?.ok).toBe(false);
	});
});
