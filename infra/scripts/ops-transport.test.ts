import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// Each case runs bash, the runner-side script and ops.sh against ssh, docker and flock shims, and a
// whole workflow's steps in some. Set here so that `bun test <this file>` gets the budget too (see
// deployment-recovery.test.ts).
setDefaultTimeout(60_000);

const repository = resolve(import.meta.dir, '../..');
const WORKFLOWS = [
	'server-status.yml',
	'server-logs.yml',
	'server-backup.yml',
	'admin-bootstrap.yml',
] as const;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The project each target must run, as this repository's compose files name it. */
async function composeName(file: string) {
	const name = (await Bun.file(join(repository, file)).text()).match(/^name: *(\S+)$/m)?.[1];
	if (!name) throw new Error(`No name: in ${file}`);
	return name;
}

const tools: Record<string, string> = {
	// sshd runs the last argument with the connection as stdin. CLOCK_SKEW shifts check-clock.sh's
	// reading of the server's clock. SSH_CUT ends the connection cleanly after that many lines of
	// output, as a dropped one can.
	ssh: `#!/bin/bash
printf '%s\\n' "$*" >> "$SSH_LOG"
for last do :; done
if [ "$last" = 'date +%s' ]; then echo $(( $(date +%s) + \${CLOCK_SKEW:-0} )); exit 0; fi
if [ -n "\${SSH_CUT:-}" ]; then bash -c "$last" | head -n "$SSH_CUT"; exit 0; fi
exec bash -c "$last"
`,
	// Records argv and the two variables a password must not travel in, then reads stdin the way
	// \`docker compose exec\` does, so a script fed to it over stdin would show up here. Each
	// checkout says which project and services Compose resolves there.
	docker: `#!/bin/bash
printf 'docker %s|ADMIN_PASSWORD=%s|OPS_SECRET=%s\\n' "$*" "\${ADMIN_PASSWORD-unset}" "\${OPS_SECRET-unset}" >> "$CALLS"
stdin=$(cat)
[ -z "$stdin" ] || printf 'stdin %s\\n' "$stdin" >> "$CALLS"
case "$*" in
  'compose config') printf 'name: %s\\nservices:\\n  api:\\n    name: not-the-project\\n' "$(cat .compose-project)" ;;
  'compose config --services') cat .compose-services ;;
  'info --format {{.DockerRootDir}}') echo /var/lib/docker ;;
esac
`,
	flock: '#!/bin/sh\necho "flock $*" >> "$CALLS"\n',
	git: '#!/bin/sh\necho abc1234\n',
	df: '#!/bin/sh\necho "Filesystem Size Used Avail Use% Mounted on"\n',
	free: '#!/bin/sh\necho "Mem: 3900 1200 2700"\n',
	uptime: '#!/bin/sh\necho "up 3 days"\n',
	'ssh-keygen': '#!/bin/sh\necho "256 SHA256:fixture root@box (ED25519)"\n',
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'starterdough-ops-'));
	roots.push(root);
	const value = {
		root,
		bin: join(root, 'bin'),
		home: join(root, 'home'),
		tmp: join(root, 'tmp'),
		state: join(root, 'state'),
		production: join(root, 'production'),
		demo: join(root, 'demo'),
	};
	await Promise.all(
		[value.bin, value.home, value.tmp, value.state, value.production, value.demo].map((path) =>
			mkdir(path),
		),
	);
	await Promise.all([
		...Object.entries(tools).map(async ([name, body]) => {
			await Bun.write(join(value.bin, name), body);
			await chmod(join(value.bin, name), 0o700);
		}),
		checkout(value.production, await composeName('infra/compose.yml'), [
			'postgres',
			'api',
			'worker',
			'backup',
		]),
		checkout(value.demo, await composeName('infra/demo/compose.yml'), [
			'postgres',
			'demo-api',
			'demo-web',
		]),
	]);
	return value;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function checkout(path: string, project: string, services: string[]) {
	await Promise.all([
		Bun.write(join(path, '.env'), 'COMPOSE_FILE=infra/compose.yml\n'),
		Bun.write(join(path, '.compose-project'), `${project}\n`),
		Bun.write(join(path, '.compose-services'), `${services.join('\n')}\n`),
	]);
}

async function spawn(value: Fixture, argv: string[], env: Record<string, string>) {
	const child = Bun.spawn(argv, {
		cwd: repository,
		env: {
			PATH: `${value.bin}:${process.env.PATH ?? ''}`,
			HOME: value.home,
			TMPDIR: value.tmp,
			RUNNER_TEMP: value.root,
			STARTERDOUGH_STATE_DIR: value.state,
			CALLS: join(value.root, 'calls'),
			SSH_LOG: join(value.root, 'ssh'),
			...env,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function logs(value: Fixture) {
	const read = async (name: string) => {
		const file = Bun.file(join(value.root, name));
		return (await file.exists()) ? file.text() : '';
	};
	const calls = (await read('calls')).split('\n').filter(Boolean);
	return {
		calls,
		/** What each `docker` call was asked, without the environment it was given. */
		docker: calls
			.filter((line) => line.startsWith('docker '))
			.map((line) => line.slice('docker '.length).split('|')[0]),
		ssh: await read('ssh'),
	};
}

async function ops(value: Fixture, args: string[], env: Record<string, string> = {}) {
	const result = await spawn(
		value,
		['bash', join(repository, '.github/scripts/run-ops.sh'), ...args],
		{
			OPS_CHECKOUT: value.production,
			OPS_COMPOSE_FILE: 'infra/compose.yml',
			...env,
		},
	);
	return { ...result, ...(await logs(value)) };
}

type Dispatch = {
	inputs?: Record<string, string | boolean>;
	vars?: Record<string, string>;
	secrets?: Record<string, string>;
	private?: boolean;
	/** For the shims: CLOCK_SKEW. */
	env?: Record<string, string>;
};

async function workflow(file: string) {
	const parsed: unknown = Bun.YAML.parse(
		await Bun.file(join(repository, '.github/workflows', file)).text(),
	);
	if (!record(parsed) || !record(parsed.jobs)) throw new Error(`No jobs in ${file}`);
	const jobs = Object.values(parsed.jobs);
	const [job] = jobs;
	if (jobs.length !== 1 || !record(job) || !Array.isArray(job.steps)) {
		throw new Error(`${file} should have one job with steps`);
	}
	return {
		parsed,
		job,
		steps: job.steps.filter((value): value is Record<string, unknown> => record(value)),
	};
}

/**
 * The `${{ }}` forms these workflows use in `env:`, and nothing else: a new form fails here rather
 * than being guessed at.
 */
function evaluate(value: unknown, context: Record<string, unknown>, where: string) {
	if (typeof value !== 'string') return String(value);
	const expression = value.match(/^\$\{\{ (.+) \}\}$/)?.[1];
	if (expression === undefined) {
		if (value.includes('${{')) throw new Error(`${where}: unsupported ${value}`);
		return value;
	}
	const parts = expression.match(/^([\w.]+)(?: && '([^']*)')?(?: \|\| '([^']*)')?$/);
	if (!parts?.[1]) throw new Error(`${where}: unsupported ${value}`);
	let current: unknown = context;
	for (const key of parts[1].split('.')) current = record(current) ? current[key] : undefined;
	const truthy = current !== undefined && current !== '' && current !== false;
	if (parts[2] !== undefined) return truthy ? parts[2] : (parts[3] ?? '');
	return truthy ? String(current) : (parts[3] ?? '');
}

/** Runs a workflow's `run:` steps in order, as a dispatch would, and stops at the first failure. */
async function dispatch(value: Fixture, file: string, options: Dispatch = {}) {
	const { parsed, job, steps } = await workflow(file);
	const on = record(parsed.on) ? parsed.on : {};
	const trigger = record(on.workflow_dispatch) ? on.workflow_dispatch : {};
	const inputs = Object.fromEntries(
		Object.entries(record(trigger.inputs) ? trigger.inputs : {}).map(([name, input]) => [
			name,
			options.inputs?.[name] ?? (record(input) ? input.default : undefined),
		]),
	);
	const context = {
		inputs,
		vars: {
			DEPLOY_ENABLED: 'true',
			DEPLOY_HOST: '203.0.113.7',
			DEPLOY_PATH: value.production,
			DEPLOY_KNOWN_HOSTS: 'ssh-ed25519 AAAAone',
			DEMO_PATH: value.demo,
			...options.vars,
		},
		secrets: { DEPLOY_SSH_KEY: 'synthetic-fixture-key', ...options.secrets },
		github: { event: { repository: { private: options.private ?? true } } },
	};
	const environment = (env: unknown, where: string) =>
		Object.fromEntries(
			Object.entries(record(env) ? env : {}).map(([key, entry]) => [
				key,
				evaluate(entry, context, `${where} ${key}`),
			]),
		);
	const jobEnv = environment(job.env, file);
	let stdout = '';
	let stderr = '';
	for (const step of steps) {
		if (typeof step.uses === 'string') continue;
		const name = String(step.name);
		if (typeof step.run !== 'string' || step.if !== undefined) {
			throw new Error(`${file}: cannot run step ${name}`);
		}
		// How Actions runs a step that names no `shell:`.
		const result = await spawn(value, ['bash', '-e', '-c', step.run], {
			...options.env,
			...jobEnv,
			...environment(step.env, `${file} ${name}`),
		});
		stdout += result.stdout;
		stderr += result.stderr;
		if (result.code !== 0) {
			return { code: result.code, failed: name, stdout, stderr, ...(await logs(value)) };
		}
	}
	return { code: 0, failed: null, stdout, stderr, ...(await logs(value)) };
}

/** Inputs that let each workflow run to the end against the fixture. */
const RUNNABLE: Record<(typeof WORKFLOWS)[number], Dispatch> = {
	'server-status.yml': {},
	'server-logs.yml': {},
	'server-backup.yml': {},
	'admin-bootstrap.yml': {
		inputs: { email: 'ann@example.com' },
		secrets: { ADMIN_BOOTSTRAP_PASSWORD: 'fixture-password-1234' },
	},
};

describe('ops.sh through run-ops.sh', () => {
	it('reads status without a lock or a write, and nothing swallows the script', async () => {
		const value = await fixture();
		const production = await composeName('infra/compose.yml');
		const result = await ops(value, ['status', '50']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(`project ${production} in ${value.production} at abc1234`);
		expect(result.stdout).toContain('== deployment journal: none');
		expect(result.stdout).toContain('256 SHA256:fixture root@box (ED25519)');
		expect(result.stdout.trim().split('\n').at(-1)).toBe('STARTERDOUGH_OPS_COMPLETE=status');
		// The API's logs and the worker's; the demo's API is not a service of this checkout.
		expect(result.docker).toEqual([
			'compose config',
			'compose ps --all',
			'info --format {{.DockerRootDir}}',
			'system df',
			'compose config --services',
			'compose logs --no-color --timestamps --tail 50 api',
			'compose logs --no-color --timestamps --tail 50 worker',
		]);
		expect(result.calls.filter((line) => !line.startsWith('docker '))).toEqual([]);
		// The shipped copy of ops.sh is gone once it has run.
		expect(await readdir(value.tmp)).toEqual([]);
	});

	it('prints no log lines for `status 0`, and says when a deployment waits for recovery', async () => {
		const value = await fixture();
		await Bun.write(join(value.state, 'deployment-interrupted'), '{}');
		const result = await ops(value, ['status', '0']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('== deployment journal: PENDING');
		expect(result.stdout).not.toContain('lines of');
		expect(
			result.docker.filter((call) => call.includes('logs') || call.includes('--services')),
		).toEqual([]);
	});

	it('counts a run only once ops.sh has printed its last line', async () => {
		const whole = await ops(await fixture(), ['status', '0']);
		expect(whole.code, whole.stderr).toBe(0);
		const lines = whole.stdout.trim().split('\n').length;
		// Everything but the marker arrives, and ssh still exits 0.
		const cut = await ops(await fixture(), ['status', '0'], { SSH_CUT: String(lines - 1) });
		expect(cut.stdout.trim().split('\n')).toHaveLength(lines - 1);
		expect(cut.stdout).not.toContain('STARTERDOUGH_OPS_COMPLETE');
		expect(cut.code).not.toBe(0);
	});

	it('hands the admin password to create-admin on stdin only', async () => {
		const value = await fixture();
		// Built at run time, so the only way into a log is through the scripts under test.
		const secret = `pw-${crypto.randomUUID()}`;
		const result = await ops(value, ['admin', 'ann@example.com', 'Ann Lee', 'no'], {
			OPS_SECRET: secret,
		});
		expect(result.code, result.stderr).toBe(0);
		const exec = result.calls.findIndex((line) => line.includes('compose exec'));
		expect(result.calls[exec]).toBe(
			'docker compose exec -T -e ADMIN_PASSWORD= api bun run admin:create -- --email ann@example.com --name Ann Lee|ADMIN_PASSWORD=unset|OPS_SECRET=unset',
		);
		expect(result.calls[exec + 1]).toBe(`stdin ${secret}`);
		expect(result.calls.filter((line) => line.includes(secret))).toHaveLength(1);
		expect(result.calls.indexOf('flock -w 600 8')).toBeLessThan(exec);
		// Not on the remote command line, and not echoed.
		expect(result.ssh).not.toContain(secret);
		expect(result.stdout + result.stderr).not.toContain(secret);
	});

	it('promotes without a password, and creates no administrator without one', async () => {
		const value = await fixture();
		const secret = `pw-${crypto.randomUUID()}`;
		const promoted = await ops(value, ['admin', 'ann@example.com', '', 'yes'], {
			OPS_SECRET: secret,
		});
		expect(promoted.code, promoted.stderr).toBe(0);
		expect(promoted.docker.at(-1)).toBe(
			'compose exec -T -e ADMIN_PASSWORD= api bun run admin:create -- --email ann@example.com --name  --yes',
		);
		expect(promoted.calls.join('\n')).not.toContain(secret);
		expect(promoted.calls.some((line) => line.startsWith('stdin '))).toBe(false);

		const other = await fixture();
		const refused = await ops(other, ['admin', 'ann@example.com', '', 'no']);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain('the ADMIN_BOOTSTRAP_PASSWORD secret is empty');
		expect(refused.docker).toEqual(['compose config']);

		// create-admin reads its own flags from argv: `--name --yes` would turn a creation into a
		// promotion.
		for (const [email, name] of [
			['-x@example.com', ''],
			['ann@example.com', '--yes'],
		]) {
			const flag = await ops(await fixture(), ['admin', email, name, 'no'], { OPS_SECRET: secret });
			expect(flag.code, `${email} ${name}`).not.toBe(0);
			expect(flag.docker, `${email} ${name}`).toEqual(['compose config']);
		}

		const pending = await fixture();
		await Bun.write(join(pending.state, 'deployment-interrupted'), '{}');
		const waiting = await ops(pending, ['admin', 'ann@example.com', '', 'no'], {
			OPS_SECRET: secret,
		});
		expect(waiting.code).not.toBe(0);
		expect(waiting.stderr).toContain('a deployment is waiting for recovery');
		expect(waiting.docker.some((call) => call.includes('exec'))).toBe(false);
	});

	it('runs a release drill, and every other backup action, under the host lock', async () => {
		for (const [args, command] of [
			[['drill', 'release'], 'restore latest --drill --release'],
			[['list', 'nightly'], 'list --no-max-age'],
			[['backup', 'release'], 'backup --release'],
		] as const) {
			const value = await fixture();
			const result = await ops(value, ['backup', ...args]);
			expect(result.code, result.stderr).toBe(0);
			expect(result.calls.filter((line) => !line.startsWith('docker compose config|'))).toEqual([
				'flock -w 600 8',
				`docker compose run --rm --no-deps -T backup bun src/cli.ts ${command}|ADMIN_PASSWORD=unset|OPS_SECRET=unset`,
			]);
		}
		const value = await fixture();
		const restore = await ops(value, ['backup', 'restore', 'nightly']);
		expect(restore.code).not.toBe(0);
		expect(restore.calls).not.toContain('flock -w 600 8');
	});

	it('reads one service, and refuses one this checkout does not run', async () => {
		const value = await fixture();
		const result = await ops(value, ['logs', 'api', '100', '2h']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.docker.at(-1)).toBe(
			'compose logs --no-color --timestamps --tail 100 --since 2h api',
		);
		for (const args of [
			['logs', 'demo-api', '100', ''],
			['logs', 'api', '100', '-5m'],
			['logs', 'api', 'all', ''],
		]) {
			const refused = await ops(await fixture(), args);
			expect(refused.code, args.join(' ')).not.toBe(0);
			expect(
				refused.docker.some((call) => call.includes('logs')),
				args.join(' '),
			).toBe(false);
		}
	});

	it('refuses what could escape its quotes, or reach the wrong place, before connecting', async () => {
		for (const [args, env, title] of [
			[['logs', "api'; touch /tmp/owned; '", '10'], {}, 'Unsafe input'],
			[['admin', 'ann@example.com', 'Ann $(id)', 'no'], {}, 'Unsafe input'],
			[['admin', 'ann@example.com', '', 'no'], { OPS_SECRET: 'two\nlines' }, 'Unusable secret'],
			[['restore', 'latest'], {}, 'Unknown command'],
			[['status', '50'], { COMPOSE_PROJECT: 'Lumen' }, 'No Compose project'],
			[['status', '50'], { OPS_CHECKOUT: "/opt/it's" }, 'No checkout path'],
			[['status', '50'], { OPS_COMPOSE_FILE: '../elsewhere.yml' }, 'No Compose file'],
		] as const) {
			const value = await fixture();
			const result = await ops(value, [...args], env);
			expect(result.code, title).not.toBe(0);
			expect(result.stdout, title).toContain(`::error title=${title}::`);
			expect(result.ssh, title).toBe('');
			expect(result.calls, title).toEqual([]);
		}
	});

	it('refuses every command in a checkout that runs another Compose project', async () => {
		const production = await composeName('infra/compose.yml');
		for (const args of [
			['status', '50'],
			['logs', 'api', '10'],
			['backup', 'backup', 'nightly'],
			['admin', 'ann@example.com', '', 'no'],
		]) {
			const value = await fixture();
			await Bun.write(join(value.production, '.compose-project'), 'lumen\n');
			const result = await ops(value, args, { OPS_SECRET: 'fixture-password-1234' });
			expect(result.code, args[0]).not.toBe(0);
			expect(result.stderr, args[0]).toContain(
				`this checkout runs Compose project 'lumen', not '${production}'`,
			);
			// Reading the project is the only thing asked of Docker.
			expect(result.calls, args[0]).toEqual([
				'docker compose config|ADMIN_PASSWORD=unset|OPS_SECRET=unset',
			]);
		}

		// The repository variable COMPOSE_PROJECT_NAME is how a renamed project is expected.
		const renamed = await fixture();
		await Bun.write(join(renamed.production, '.compose-project'), 'lumen\n');
		expect((await ops(renamed, ['status', '0'], { COMPOSE_PROJECT: 'lumen' })).code).toBe(0);

		const empty = await fixture();
		await rm(join(empty.production, '.env'));
		const noEnv = await ops(empty, ['status', '0']);
		expect(noEnv.code).not.toBe(0);
		expect(noEnv.calls).toEqual([]);
	});
});

describe('the ops workflows', () => {
	it('run by hand only, in production, each in a group of its own, after the pinned host key', async () => {
		for (const file of WORKFLOWS) {
			const { parsed, job, steps } = await workflow(file);
			expect(Object.keys(record(parsed.on) ? parsed.on : {}), file).toEqual(['workflow_dispatch']);
			expect(parsed.permissions, file).toEqual({ contents: 'read' });
			// Not Deploy's group, where a waiting release would be cancelled by this run.
			expect(parsed.concurrency, file).toEqual({
				group: basename(file, '.yml'),
				'cancel-in-progress': false,
			});
			expect(job.environment, file).toBe('production');
			expect(job['timeout-minutes'], file).toBeGreaterThan(0);
			const runs = steps.map((step) => (typeof step.run === 'string' ? step.run : ''));
			// Without --recovery, so DEPLOY_ENABLED gates it as it gates Deploy.
			const pinned = runs.indexOf('bash .github/scripts/ssh-target.sh');
			const reaching = runs.findIndex((run) => /run-ops\.sh|check-clock\.sh|ssh target/.test(run));
			expect(pinned, file).toBeGreaterThan(-1);
			expect(pinned, file).toBeLessThan(reaching);
			for (const step of steps) {
				if (typeof step.uses === 'string') expect(step.uses, file).toMatch(/@[0-9a-f]{40}$/);
			}
		}
	});

	it('pin both forms of the host key, a pasted CR included, and stay off while deploys are', async () => {
		for (const file of WORKFLOWS) {
			const value = await fixture();
			const vars = {
				DEPLOY_KNOWN_HOSTS: '203.0.113.7 ssh-ed25519 AAAAone\r\nssh-ed25519 AAAAtwo comment\r\n',
			};
			const result = await dispatch(value, file, {
				...RUNNABLE[file],
				vars: { ...RUNNABLE[file].vars, ...vars },
			});
			expect(result.code, `${file}: ${result.stdout}${result.stderr}`).toBe(0);
			expect(result.stdout, file).toContain(`STARTERDOUGH_OPS_COMPLETE=`);
			expect(await Bun.file(join(value.home, '.ssh/known_hosts_deploy')).text(), file).toBe(
				'deploy-target ssh-ed25519 AAAAone\ndeploy-target ssh-ed25519 AAAAtwo\n',
			);
			expect(await Bun.file(join(value.home, '.ssh/config')).text(), file).toContain(
				'StrictHostKeyChecking yes',
			);

			const off = await fixture();
			const stopped = await dispatch(off, file, {
				...RUNNABLE[file],
				vars: { ...RUNNABLE[file].vars, DEPLOY_ENABLED: '' },
			});
			expect(stopped.failed, file).toBe('SSH to the server, host key pinned');
			expect(stopped.ssh, file).toBe('');
		}

		// Recover deployment's --recovery is the one way through while deploys are off.
		const recovery = await spawn(
			await fixture(),
			['bash', '.github/scripts/ssh-target.sh', '--recovery'],
			{
				DEPLOY_ENABLED: '',
				DEPLOY_HOST: '203.0.113.7',
				DEPLOY_USER: 'deploy',
				DEPLOY_PATH: '/opt/lumen',
				DEPLOY_KNOWN_HOSTS: 'ssh-ed25519 AAAAone',
				DEPLOY_SSH_KEY: 'synthetic-fixture-key',
			},
		);
		expect(recovery.code, recovery.stdout).toBe(0);
	});

	it('leave the log lines out of Server status in a public repository', async () => {
		const value = await fixture();
		const result = await dispatch(value, 'server-status.yml', {
			inputs: { lines: '1000' },
			private: false,
		});
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('::notice title=No log lines::');
		expect(result.docker.some((call) => call.includes('logs'))).toBe(false);

		const other = await fixture();
		const inPrivate = await dispatch(other, 'server-status.yml', { inputs: { lines: '1000' } });
		expect(inPrivate.docker).toContain('compose logs --no-color --timestamps --tail 1000 api');
	});

	it('refuse Server logs in a public repository before anything else runs', async () => {
		const value = await fixture();
		const result = await dispatch(value, 'server-logs.yml', {
			private: false,
			vars: { DEPLOY_ENABLED: '' },
		});
		expect(result.failed).toBe('Refuse in a public repository');
		expect(result.stdout).toContain('::error title=Public repository::');
		expect(result.ssh).toBe('');
		expect(result.calls).toEqual([]);
		expect(await Bun.file(join(value.home, '.ssh/config')).exists()).toBe(false);

		const other = await fixture();
		const inPrivate = await dispatch(other, 'server-logs.yml', {
			inputs: { service: 'worker', lines: '100', since: '30m' },
		});
		expect(inPrivate.code, inPrivate.stderr).toBe(0);
		expect(inPrivate.docker.at(-1)).toBe(
			'compose logs --no-color --timestamps --tail 100 --since 30m worker',
		);
	});

	it("aim the demo target at DEMO_PATH and the demo's own project", async () => {
		const demo = await composeName('infra/demo/compose.yml');
		// The repository variable renames production's project, never the demo's.
		const vars = { COMPOSE_PROJECT_NAME: 'lumen' };
		const value = await fixture();
		const status = await dispatch(value, 'server-status.yml', {
			inputs: { target: 'demo', lines: '50' },
			vars,
		});
		expect(status.code, status.stderr).toBe(0);
		expect(status.stdout).toContain(`project ${demo} in ${value.demo}`);
		expect(status.docker).toContain('compose logs --no-color --timestamps --tail 50 demo-api');

		// A promotion, which needs no ADMIN_BOOTSTRAP_PASSWORD.
		const other = await fixture();
		const admin = await dispatch(other, 'admin-bootstrap.yml', {
			inputs: { target: 'demo', email: 'ann@example.com', promote: true },
			vars,
		});
		expect(admin.code, admin.stderr).toBe(0);
		expect(admin.docker.at(-1)).toBe(
			'compose exec -T -e ADMIN_PASSWORD= demo-api bun run admin:create -- --email ann@example.com --name  --yes',
		);

		// The same variable on production, whose checkout still runs the kit's project, is refused.
		const renamed = await fixture();
		const refused = await dispatch(renamed, 'server-status.yml', { vars });
		expect(refused.failed).toBe('Status');
		expect(refused.stderr).toContain(
			`runs Compose project '${await composeName('infra/compose.yml')}', not 'lumen'`,
		);

		for (const file of ['server-status.yml', 'server-logs.yml', 'admin-bootstrap.yml']) {
			const none = await fixture();
			const result = await dispatch(none, file, {
				...RUNNABLE[file as keyof typeof RUNNABLE],
				inputs: { ...RUNNABLE[file as keyof typeof RUNNABLE].inputs, target: 'demo' },
				vars: { DEMO_PATH: '' },
			});
			expect(result.code, file).not.toBe(0);
			expect(result.stdout, file).toContain('::error title=No demo::');
			expect(result.calls, file).toEqual([]);
		}
	});

	it('need a 12-character password for Admin bootstrap unless it promotes', async () => {
		for (const [options, title] of [
			[{ inputs: { email: 'ann@example.com' } }, 'No usable password'],
			[
				{ inputs: { email: 'ann@example.com' }, secrets: { ADMIN_BOOTSTRAP_PASSWORD: 'short' } },
				'No usable password',
			],
			[
				{ ...RUNNABLE['admin-bootstrap.yml'], inputs: { email: '-x@example.com' } },
				'No email address',
			],
			[
				{
					...RUNNABLE['admin-bootstrap.yml'],
					inputs: { email: 'ann@example.com', name: 'Jürgen' },
				},
				'Unusable name',
			],
		] as const) {
			const value = await fixture();
			const result = await dispatch(value, 'admin-bootstrap.yml', options);
			expect(result.failed, title).toBe('Create or promote the administrator');
			expect(result.stdout, title).toContain(`::error title=${title}::`);
			expect(result.calls, title).toEqual([]);
		}

		const secret = `pw-${crypto.randomUUID()}`;
		const value = await fixture();
		const created = await dispatch(value, 'admin-bootstrap.yml', {
			inputs: { email: 'ann@example.com', name: 'Ann Lee' },
			secrets: { ADMIN_BOOTSTRAP_PASSWORD: secret },
		});
		expect(created.code, created.stderr).toBe(0);
		expect(created.calls.filter((line) => line.includes(secret))).toEqual([`stdin ${secret}`]);
		expect(created.ssh + created.stdout + created.stderr).not.toContain(secret);

		// A promotion sends no password, even when the secret is set.
		const other = await fixture();
		const promoted = await dispatch(other, 'admin-bootstrap.yml', {
			inputs: { email: 'ann@example.com', name: 'Ann Lee', promote: true },
			secrets: { ADMIN_BOOTSTRAP_PASSWORD: secret },
		});
		expect(promoted.code, promoted.stderr).toBe(0);
		expect(promoted.docker.at(-1)).toBe(
			'compose exec -T -e ADMIN_PASSWORD= api bun run admin:create -- --email ann@example.com --name Ann Lee --yes',
		);
		expect(promoted.calls.join('\n')).not.toContain(secret);
	});

	it('check the server clock strictly only before taking a backup', async () => {
		const skew = { CLOCK_SKEW: '120' };
		for (const action of ['list', 'drill']) {
			const value = await fixture();
			const result = await dispatch(value, 'server-backup.yml', { inputs: { action }, env: skew });
			expect(result.code, action).toBe(0);
			expect(result.stdout, action).toContain('::warning title=Server clock::');
		}
		const value = await fixture();
		const refused = await dispatch(value, 'server-backup.yml', {
			inputs: { action: 'backup' },
			env: skew,
		});
		expect(refused.failed).toBe("Server clock against the runner's");
		expect(refused.calls).toEqual([]);
	});
});
