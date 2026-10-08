import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
		async nodeVersion() {
			return null;
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

	it('names the way around Docker in every failed Docker check', async () => {
		const report = await doctor({}, dependencies({}));
		const docker = report.checks.filter((check) => check.name.startsWith('Docker'));
		expect(docker.map((check) => check.ok)).toEqual([false, false, false]);
		for (const check of docker) {
			expect(check.detail).toContain('or rerun with `bun run doctor -- --database=external`');
		}
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

	it('uses only the root .env and inherited shell overrides for server configuration', async () => {
		await writeFile(
			join(root, '.env'),
			[
				'NODE_ENV=development',
				'DATABASE_URL=postgres://starterdough:starterdough@localhost:5433/starterdough',
				'BETTER_AUTH_SECRET=',
			].join('\n'),
		);
		await writeFile(join(root, '.env.local'), `BETTER_AUTH_SECRET=${'l'.repeat(48)}\n`);

		const fileOnly = await doctor({ database: 'external' }, dependencies({}));
		expect(fileOnly.ok).toBe(false);
		expect(fileOnly.checks.find((check) => check.name === 'Root environment')?.detail).toContain(
			'BETTER_AUTH_SECRET is missing',
		);

		const inherited = await doctor(
			{ database: 'external' },
			dependencies({}, { BETTER_AUTH_SECRET: 's'.repeat(48) }),
		);
		expect(inherited.ok).toBe(true);
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
		expect(formatDoctorReport(report)).toContain('run `bun run setup`');
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
			'SITE_URL is missing; `bun run setup` sets the local origin',
		);
		expect(missing.checks.find((check) => check.name === 'Documentation build')?.detail).toBe(
			'SITE_URL is missing; `bun run setup` sets the local origin',
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

	it('fails a Node on PATH that is older than SvelteKit 3 needs, and passes without one', async () => {
		const nodeCheck = async (printed: string | null) => {
			const deps = dependencies({});
			deps.nodeVersion = async () => printed;
			const report = await doctor({ database: 'external' }, deps);
			return { ok: report.ok, check: report.checks.find((check) => check.name === 'Node.js') };
		};

		expect(await nodeCheck(null)).toEqual({
			ok: true,
			check: { name: 'Node.js', ok: true, detail: 'not on PATH; Bun runs Vite itself' },
		});
		expect((await nodeCheck('v22.17.0\n')).check?.ok).toBe(true);
		expect((await nodeCheck('v26.1.0\n')).check?.ok).toBe(true);
		expect(await nodeCheck('v22.16.0\n')).toEqual({
			ok: false,
			check: {
				name: 'Node.js',
				ok: false,
				detail:
					'Node 22.16.0 is on your PATH; SvelteKit 3 needs 22.17 or newer (bun run starts Vite with it). Upgrade Node or remove it from PATH',
			},
		});
		expect((await nodeCheck('v20.19.5\n')).check?.ok).toBe(false);
		// A `node` that will not run is no better than an old one; its output is never echoed.
		const broken = await nodeCheck('');
		expect(broken.check?.ok).toBe(false);
		expect(broken.check?.detail).toContain('Node of an unreadable version is on your PATH');
	});

	it('asks the node that is first on PATH, and counts Bun standing in for it as none', async () => {
		/** The doctor's own command line, with nothing on PATH but `bin`. */
		const run = (bin: string) =>
			Bun.spawnSync(
				[
					process.execPath,
					'--no-env-file',
					join(import.meta.dir, 'doctor.ts'),
					'--database=external',
				],
				{ env: { PATH: bin }, stderr: 'pipe' },
			)
				.stdout.toString()
				.split('\n')
				.find((line) => line.includes('Node.js'));

		const old = join(root, 'old-node');
		await mkdir(old);
		await writeFile(join(old, 'node'), '#!/bin/sh\necho v20.11.1\n');
		await chmod(join(old, 'node'), 0o755);
		expect(run(old)).toStartWith('✗ Node.js: Node 20.11.1 is on your PATH');

		// What `bun run` does on a machine without Node: Bun itself, under the name `node`, in a
		// `bun-node-*` directory. It fails `--version`, so it is recognised by name and by target.
		const stub = join(root, 'bun-node-0123abc');
		await mkdir(stub);
		await writeFile(join(stub, 'node'), '#!/bin/sh\nexit 1\n');
		await chmod(join(stub, 'node'), 0o755);
		expect(run(stub)).toBe('✓ Node.js: not on PATH; Bun runs Vite itself');

		const link = join(root, 'linked');
		await mkdir(link);
		await symlink(process.execPath, join(link, 'node'));
		expect(run(link)).toBe('✓ Node.js: not on PATH; Bun runs Vite itself');
	}, 20_000);

	it('fails on an old Bun and incomplete dependency install', async () => {
		await rm(join(root, 'node_modules/.bin/turbo'));
		const deps = dependencies();
		deps.bunVersion = '1.3.9';
		const report = await doctor({}, deps);
		expect(report.checks.find((check) => check.name === 'Bun runtime')?.ok).toBe(false);
		expect(report.checks.find((check) => check.name === 'Dependencies')?.ok).toBe(false);
	});
});
