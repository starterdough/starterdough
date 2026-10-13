import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The real deploy.sh and recovery helpers against docker, git and flock shims: dozens of processes
// per case, many times slower on a loaded machine. Set here so that `bun test <this file>` gets the
// budget too (see deployment-recovery.test.ts).
setDefaultTimeout(60_000);

const scripts = resolve(import.meta.dir);
const revision = '1234567890abcdef1234567890abcdef12345678';
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(env = 'IMAGE_REGISTRY=ghcr.io/example/app\nIMAGE_TAG=sha-old\n') {
	const root = await mkdtemp(join(tmpdir(), 'starterdough-deploy-'));
	roots.push(root);
	const checkout = join(root, 'checkout');
	const bin = join(root, 'bin');
	const state = join(root, 'state');
	await Promise.all([mkdir(join(checkout, 'infra/scripts'), { recursive: true }), mkdir(bin)]);
	for (const name of [
		'deploy.sh',
		'operation-lock.sh',
		'deployment-recovery.sh',
		'deployment-recovery.py',
	]) {
		await cp(join(scripts, name), join(checkout, 'infra/scripts', name));
	}
	await Bun.write(join(checkout, '.env'), env);
	// One running API (old) that `stop` stops, and the candidate (new) that `up` would start. The
	// project is renamed (`lumen`), which the recovery journal must take from Compose.
	await Bun.write(
		join(bin, 'docker'),
		`#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_LOG'], 'a') as log: log.write(' '.join(args) + '\\n')
old, new = '${'a'.repeat(64)}', '${'e'.repeat(64)}'
image = 'sha256:' + 'c' * 64
state = os.environ['STARTERDOUGH_STATE_DIR']
stopped = os.path.join(state, 'old-stopped')
def container(cid, running):
    return json.dumps([{'Id': cid, 'Image': image, 'Config': {'Image': 'ghcr.io/example/app/api:x',
        'Labels': {'com.docker.compose.project': 'lumen', 'com.docker.compose.service': 'api'}},
        'State': {'Running': running}}])
if args[:4] == ['compose', 'config', '--format', 'json']:
    services = {'postgres': {'image': 'pgvector/pgvector:pg17'}, 'api': {'image': 'ghcr.io/example/app/api:x'}}
    missing = os.environ.get('NO_BACKUP_SERVICE')
    # Compose refuses a service named on the command line that the file does not define.
    if missing == 'refused' and 'backup' in args[4:]: raise SystemExit(1)
    if not missing: services['backup'] = {'image': 'ghcr.io/example/app/backup:x', 'profiles': ['backup']}
    print(json.dumps({'name': 'lumen', 'services': services}))
elif args[:3] == ['compose', 'config', '--images']: print('ghcr.io/example/app/api:x')
elif args[:3] == ['compose', 'config', '--services']: print('postgres\\napi')
elif args[:4] == ['image', 'inspect', '--format', '{{.Id}}']: print(image)
elif args[:4] == ['compose', 'ps', '--status', 'running']:
    if not os.path.exists(stopped): print(old)
elif args[:3] == ['compose', 'ps', '--quiet']: print(new)
elif args[:1] == ['inspect']: print(container(args[1], args[1] == new or not os.path.exists(stopped)))
elif args[:1] == ['stop']: open(stopped, 'w').close()
elif args[:3] == ['compose', 'run', '--rm']:
    # A release backup taken after the journal exists would come too late to be a restore point.
    if os.path.exists(os.path.join(state, 'deployment-interrupted')): raise SystemExit(92)
    if os.environ.get('BACKUP_FAIL') == '1': raise SystemExit(1)
elif args[:2] == ['image', 'ls']:
    if os.environ.get('IMAGE_LS_FAIL') == '1': raise SystemExit(1)
    for tag in ['sha-5', 'sha-4', 'sha-3', 'sha-2', 'sha-1', '<none>']: print('ghcr.io/example/app/api\\t' + tag)
    print('ghcr.io/example/app/web\\tsha-5')
elif args[:2] == ['image', 'rm']:
    # In use by a container, as the demo's image may be.
    if args[2].endswith(':sha-2'): raise SystemExit(1)
`,
	);
	await Bun.write(
		join(bin, 'git'),
		`#!/bin/sh\ncase "$1" in rev-parse) echo ${revision} ;; esac\nexit 0\n`,
	);
	await Bun.write(
		join(bin, 'flock'),
		`#!/usr/bin/env python3
import fcntl, sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | (fcntl.LOCK_NB if '-n' in sys.argv else 0))
`,
	);
	// deploy.sh targets GNU sed on the server; BSD sed spells in-place editing `-i ''`.
	if (process.platform === 'darwin') {
		await Bun.write(
			join(bin, 'sed'),
			'#!/bin/sh\nif [ "$1" = -i ]; then shift; exec /usr/bin/sed -i "" "$@"; fi\nexec /usr/bin/sed "$@"\n',
		);
		await chmod(join(bin, 'sed'), 0o700);
	}
	await Promise.all(['docker', 'git', 'flock'].map((name) => chmod(join(bin, name), 0o700)));
	return { root, checkout, bin, state, log: join(root, 'docker.log') };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function hook(
	value: Fixture,
	stage: 'pre-deploy' | 'post-deploy',
	name: string,
	body: string,
) {
	const directory = join(value.checkout, 'infra/scripts/hooks', `${stage}.d`);
	await mkdir(directory, { recursive: true });
	await Bun.write(join(directory, name), body);
}

async function deploy(value: Fixture, env: Record<string, string> = {}) {
	await mkdir(value.state, { recursive: true });
	const child = Bun.spawn(['bash', join(value.checkout, 'infra/scripts/deploy.sh')], {
		cwd: value.root,
		env: {
			...process.env,
			// What deploy.sh reads from its environment, blank unless a case sets it: `bun test` loads
			// the developer's own .env into process.env.
			GIT_REF: '',
			BUILD: '',
			IMAGE_REGISTRY: '',
			RELEASE_BACKUP: '',
			STARTERDOUGH_OPERATION_LOCK_HELD: '',
			PATH: `${value.bin}:${process.env.PATH ?? ''}`,
			DOCKER_LOG: value.log,
			STARTERDOUGH_STATE_DIR: value.state,
			HOOK_LOG: join(value.root, 'hooks.log'),
			IMAGE_TAG: 'sha-new',
			...env,
		},
		// Something to read on the caller's stdin, which no hook and no backup may consume.
		stdin: new Blob(['from-the-caller\n']),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const log = Bun.file(value.log);
	const calls = (await log.exists()) ? (await log.text()).trim().split('\n') : [];
	const hooks = Bun.file(join(value.root, 'hooks.log'));
	return {
		code,
		stdout,
		stderr,
		calls,
		hooks: (await hooks.exists()) ? (await hooks.text()).trim().split('\n') : [],
		journal: await Bun.file(join(value.state, 'deployment-interrupted')).exists(),
	};
}

const index = (calls: string[], prefix: string) => calls.findIndex((c) => c.startsWith(prefix));
const releaseBackup = 'compose run --rm --no-deps -T backup bun src/cli.ts backup --release';
const startPostgres = 'compose up -d --no-recreate --wait --wait-timeout 180 postgres';
const startRelease = 'compose up -d --remove-orphans';

describe('deploy.sh release backup', () => {
	it('backs up after pulling and before the journal or any writer stops', async () => {
		const value = await fixture();
		const result = await deploy(value);
		expect(result.code, result.stderr).toBe(0);
		const { calls } = result;
		const backup = index(calls, releaseBackup);
		expect(backup).toBeGreaterThan(-1);
		expect(index(calls, 'compose pull --quiet')).toBeLessThan(
			index(calls, 'compose config --format json backup'),
		);
		expect(index(calls, 'compose config --format json backup')).toBeLessThan(
			index(calls, 'compose pull --quiet backup'),
		);
		expect(index(calls, 'compose pull --quiet backup')).toBeLessThan(index(calls, startPostgres));
		expect(index(calls, startPostgres)).toBeLessThan(backup);
		expect(backup).toBeLessThan(index(calls, 'stop --time 120'));
		expect(backup).toBeLessThan(index(calls, startRelease));
		expect(result.stdout).toContain('✓ deployed sha-new');
		expect(result.journal).toBe(false);
	});

	it('builds the backup image instead of pulling it with BUILD=1', async () => {
		const value = await fixture();
		const result = await deploy(value, { BUILD: '1' });
		expect(result.code, result.stderr).toBe(0);
		expect(index(result.calls, 'compose pull')).toBe(-1);
		expect(index(result.calls, 'compose build --pull')).toBeLessThan(
			index(result.calls, 'compose build backup'),
		);
		expect(index(result.calls, 'compose build backup')).toBeLessThan(
			index(result.calls, releaseBackup),
		);
	});

	it('stops a deploy whose backup fails, with production untouched and no journal', async () => {
		const value = await fixture();
		const result = await deploy(value, { BACKUP_FAIL: '1' });
		expect(result.code).not.toBe(0);
		expect(index(result.calls, releaseBackup)).toBeGreaterThan(-1);
		expect(index(result.calls, 'stop')).toBe(-1);
		expect(index(result.calls, startRelease)).toBe(-1);
		expect(result.journal).toBe(false);
	});

	it('skips the backup, its image and Postgres only when RELEASE_BACKUP is off', async () => {
		for (const [env, file] of [
			[{ RELEASE_BACKUP: 'off' }, ''],
			[{}, 'RELEASE_BACKUP=off\n'],
		] as const) {
			const value = await fixture(`IMAGE_REGISTRY=ghcr.io/example/app\n${file}`);
			const result = await deploy(value, env);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toContain('RELEASE_BACKUP=off: no restore point');
			for (const call of ['compose config --format json backup', 'compose pull --quiet backup']) {
				expect(result.calls).not.toContain(call);
			}
			expect(index(result.calls, startPostgres)).toBe(-1);
			expect(index(result.calls, 'compose run')).toBe(-1);
			expect(index(result.calls, 'stop --time 120')).toBeGreaterThan(-1);
		}
		// The environment wins over .env, as it does for IMAGE_TAG.
		const value = await fixture('IMAGE_REGISTRY=ghcr.io/example/app\nRELEASE_BACKUP=off\n');
		const result = await deploy(value, { RELEASE_BACKUP: 'on' });
		expect(result.code, result.stderr).toBe(0);
		expect(index(result.calls, releaseBackup)).toBeGreaterThan(-1);
	});

	it('refuses any other RELEASE_BACKUP value before changing anything', async () => {
		for (const [env, file] of [
			[{ RELEASE_BACKUP: 'no' }, ''],
			[{}, 'RELEASE_BACKUP=false\n'],
			[{}, 'RELEASE_BACKUP="off"\n'],
		] as const) {
			const value = await fixture(`IMAGE_REGISTRY=ghcr.io/example/app\n${file}`);
			const result = await deploy(value, env);
			expect(result.code, file).not.toBe(0);
			expect(result.stderr, file).toContain('RELEASE_BACKUP must be on or off');
			expect(index(result.calls, 'compose run'), file).toBe(-1);
			expect(index(result.calls, 'stop'), file).toBe(-1);
			expect(result.journal, file).toBe(false);
		}
	});

	it('refuses a stack without a backup service unless RELEASE_BACKUP is off', async () => {
		for (const missing of ['refused', 'absent']) {
			const value = await fixture();
			const result = await deploy(value, { NO_BACKUP_SERVICE: missing });
			expect(result.code, missing).not.toBe(0);
			expect(result.stderr, missing).toContain('defines no backup service; set RELEASE_BACKUP=off');
			expect(result.calls, missing).not.toContain('compose pull --quiet backup');
			expect(index(result.calls, 'compose run'), missing).toBe(-1);
			expect(index(result.calls, 'stop'), missing).toBe(-1);
			expect(result.journal, missing).toBe(false);
		}
		const value = await fixture();
		const result = await deploy(value, { NO_BACKUP_SERVICE: 'refused', RELEASE_BACKUP: 'off' });
		expect(result.code, result.stderr).toBe(0);
	});
});

describe('deploy.sh image pruning', () => {
	it('keeps the three newest builds of each image and skips one still in use', async () => {
		const value = await fixture();
		const result = await deploy(value);
		expect(result.code, result.stderr).toBe(0);
		const removed = result.calls.filter((call) => call.startsWith('image rm '));
		expect(removed).toEqual([
			'image rm ghcr.io/example/app/api:sha-2',
			'image rm ghcr.io/example/app/api:sha-1',
		]);
		// A literal backslash-t, which Docker's formatter turns into the tab awk splits on.
		expect(result.calls).toContain(
			'image ls --format {{.Repository}}\\t{{.Tag}} --filter reference=ghcr.io/example/app/*',
		);
		expect(result.calls).toContain('image prune -f');
		// After the journal is cleared: pruning is housekeeping, never part of the rollout.
		expect(index(result.calls, 'image ls')).toBeGreaterThan(index(result.calls, startRelease));
	});

	it('never fails a release that is already live', async () => {
		const value = await fixture();
		const result = await deploy(value, { IMAGE_LS_FAIL: '1' });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain('✓ deployed sha-new');
		expect(index(result.calls, 'image rm')).toBe(-1);
	});
});

describe('deploy.sh hooks', () => {
	const record =
		'printf "%s %s %s stdin=%s lock=%s\\n" "$(basename "$0")" "$IMAGE_TAG" "$DEPLOY_REVISION" ' +
		'"$(cat)" "$STARTERDOUGH_OPERATION_LOCK_HELD" >> "$HOOK_LOG"\n';

	it('runs every hook in name order, from the root, under the lock, with stdin closed', async () => {
		const value = await fixture();
		await hook(value, 'pre-deploy', '20-second.sh', record);
		await hook(value, 'pre-deploy', '10-first.sh', `${record}[ -f .env ]\n`);
		await hook(value, 'pre-deploy', 'README', 'exit 1\n');
		await hook(
			value,
			'post-deploy',
			'10-after.sh',
			// FD 8 is the deploy's own lock file, not just a descriptor that happens to be open.
			`${record}python3 -c 'import os, sys; a, b = os.fstat(8), os.stat(sys.argv[1]); sys.exit((a.st_dev, a.st_ino) != (b.st_dev, b.st_ino))' "$STARTERDOUGH_STATE_DIR/operations.lock"\n`,
		);
		const result = await deploy(value);
		expect(result.code, result.stderr).toBe(0);
		expect(result.hooks).toEqual([
			`10-first.sh sha-new ${revision} stdin= lock=1`,
			`20-second.sh sha-new ${revision} stdin= lock=1`,
			`10-after.sh sha-new ${revision} stdin= lock=1`,
		]);
	});

	it('stops before the backup and every writer on a failing pre-deploy hook', async () => {
		const value = await fixture();
		await hook(value, 'pre-deploy', '10-check.sh', 'exit 3\n');
		await hook(value, 'pre-deploy', '20-never.sh', record);
		const result = await deploy(value);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('pre-deploy hook 10-check.sh failed');
		expect(result.hooks).toEqual([]);
		expect(index(result.calls, 'compose run')).toBe(-1);
		expect(index(result.calls, 'stop')).toBe(-1);
		expect(result.journal).toBe(false);
	});

	it('fails a live release on a failing post-deploy hook, with the journal cleared', async () => {
		const value = await fixture();
		await hook(value, 'post-deploy', '10-notify.sh', 'exit 4\n');
		const result = await deploy(value);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('deployed sha-new, but a post-deploy hook failed');
		expect(result.stdout).not.toContain('✓ deployed');
		expect(index(result.calls, startRelease)).toBeGreaterThan(-1);
		expect(result.journal).toBe(false);
	});
});
