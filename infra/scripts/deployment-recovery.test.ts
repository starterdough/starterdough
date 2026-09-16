import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve(import.meta.dir, 'deployment-recovery.py');
const lockHelper = resolve(import.meta.dir, 'operation-lock.sh');
const revision = '1234567890abcdef1234567890abcdef12345678';
const oldId = 'a'.repeat(64);
const candidateId = 'e'.repeat(64);
const scaledApiId = '8'.repeat(64);
const oldImageId = `sha256:${'b'.repeat(64)}`;
const candidateImageId = `sha256:${'c'.repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'starterdough-deployment-recovery-'));
	roots.push(root);
	const bin = join(root, 'bin');
	const state = join(root, 'state');
	const log = join(root, 'docker.log');
	const running = join(root, 'running');
	await Promise.all([mkdir(bin), mkdir(state)]);
	await Promise.all([
		Bun.write(
			running,
			JSON.stringify({
				[oldId]: true,
			}),
		),
		Bun.write(log, ''),
	]);
	await Bun.write(
		join(root, 'docker.py'),
		`#!/usr/bin/env python3
import json, os, sys, time
log = os.environ['DOCKER_LOG']
running_path = os.environ['RUNNING_PATH']
old_id = '${oldId}'
candidate_id = '${candidateId}'
scaled_api_id = '${scaledApiId}'
old_image_id = '${oldImageId}'
candidate_image_id = '${candidateImageId}'
project = os.environ.get('PROJECT', 'starterdough')
primary = 'demo-api' if project == 'starterdough-demo' else 'api'
args = sys.argv[1:]
with open(log, 'a', encoding='utf-8') as handle:
    handle.write(' '.join(args) + '\\n')
def running(container_id):
    return json.load(open(running_path, encoding='utf-8')).get(container_id, False)
def set_running(container_id, value):
    states = json.load(open(running_path, encoding='utf-8'))
    states[container_id] = value
    json.dump(states, open(running_path, 'w', encoding='utf-8'))
def block():
    barrier = os.environ['BLOCK_BARRIER']
    open(barrier + '.entered', 'w', encoding='utf-8').close()
    while not os.path.exists(barrier + '.release'):
        time.sleep(0.01)
    open(barrier + '.exited', 'w', encoding='utf-8').close()
if args[:4] == ['compose', 'config', '--format', 'json']:
    services = {primary: {
        'image': 'registry.invalid/api:candidate',
        'environment': {'CONFIG_VARIANT': os.environ.get('CONFIG_VARIANT', 'original')},
    }}
    print(json.dumps({'name': project, 'services': services}))
elif args[:3] == ['compose', 'config', '--images']:
    print('registry.invalid/api:candidate')
elif args[:3] == ['compose', 'config', '--services']:
    print(primary)
elif args[:4] == ['image', 'inspect', '--format', '{{.Id}}']:
    print(os.environ.get('CANDIDATE_IMAGE_ID', candidate_image_id))
elif args[:4] == ['compose', 'ps', '--status', 'running']:
    if os.environ.get('INVENTORY_FAILURE') == '1': raise SystemExit(1)
    if os.environ.get('NO_WRITERS') != '1' and running(old_id):
        print(old_id)
        print('backup-id')
        print('foreign-id')
elif args[:3] == ['compose', 'ps', '--quiet']:
        print(candidate_id)
        if os.environ.get('SCALED_API') == '1': print(scaled_api_id)
elif args[:1] == ['inspect']:
    is_candidate = args[1] in (candidate_id, scaled_api_id)
    if is_candidate:
        service = primary
        image = candidate_image_id
        if args[1] == scaled_api_id and os.environ.get('BAD_SCALED_API') == '1':
            image = 'sha256:' + 'd' * 64
        print(json.dumps([{
            'Id': args[1],
            'Image': image,
            'Config': {'Image': 'registry.invalid/api:candidate', 'Labels': {
                'com.docker.compose.project': project,
                'com.docker.compose.service': service,
            }},
            'State': {'Running': True},
        }]))
        raise SystemExit(0)
    if args[1] == 'backup-id':
        print(json.dumps([{'Id': 'backup-id', 'Image': old_image_id, 'Config': {'Image': 'registry.invalid/backup:old', 'Labels': {'com.docker.compose.project': project, 'com.docker.compose.service': 'backup'}}, 'State': {'Running': True}}]))
        raise SystemExit(0)
    if args[1] == 'foreign-id':
        print(json.dumps([{'Id': 'foreign-id', 'Image': old_image_id, 'Config': {'Image': 'registry.invalid/api:old', 'Labels': {'com.docker.compose.project': 'other-project', 'com.docker.compose.service': primary}}, 'State': {'Running': True}}]))
        raise SystemExit(0)
    changed = os.environ.get('CHANGED_OLD_IMAGE') == '1'
    service = primary
    print(json.dumps([{
        'Id': args[1],
        'Image': ('sha256:' + 'd' * 64) if changed else old_image_id,
        'Config': {'Image': 'registry.invalid/api:old', 'Labels': {
            'com.docker.compose.project': project,
            'com.docker.compose.service': service,
        }},
        'State': {'Running': running(args[1])},
    }]))
elif args[:3] == ['stop', '--time', '120']:
    set_running(args[-1], False)
    if os.environ.get('BLOCK_STOP') == '1': block()
elif args[:1] == ['start']:
    set_running(args[-1], True)
elif args[:2] == ['compose', 'up']:
    journal = json.load(open(os.path.join(os.environ['STARTERDOUGH_STATE_DIR'], 'deployment-interrupted'), encoding='utf-8'))
    if journal.get('phase') != 'forward-only': raise SystemExit(91)
    if os.environ.get('BLOCK_UP') == '1': block()
elif args[:3] == ['compose', 'exec', '-T']:
    if os.environ.get('FAIL_READY') == '1': raise SystemExit(1)
elif args[:1] == ['exec']:
    if os.environ.get('FAIL_READY') == '1': raise SystemExit(1)
else:
    raise SystemExit(90)
`,
	);
	await Bun.write(
		join(bin, 'docker'),
		`#!/bin/sh\nexec python3 "${join(root, 'docker.py')}" "$@"\n`,
	);
	await Bun.write(
		join(bin, 'flock'),
		`#!/usr/bin/env python3
import fcntl, sys
descriptor = int(sys.argv[-1])
flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if '-n' in sys.argv else 0)
try: fcntl.flock(descriptor, flags)
except BlockingIOError: raise SystemExit(1)
`,
	);
	await Bun.write(
		join(bin, 'git'),
		`#!/bin/sh\nprintf '%s\\n' "\${CURRENT_REVISION:-${revision}}"\n`,
	);
	await Promise.all(['docker', 'flock', 'git'].map((command) => chmod(join(bin, command), 0o700)));
	return { root, state, log, running, bin };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function invoke(
	fixture: Fixture,
	command: string[],
	extra: Record<string, string> = {},
	cwd = fixture.root,
) {
	const child = Bun.spawn(
		[
			'bash',
			'-c',
			'set -euo pipefail; source "$LOCK_HELPER"; acquire_operation_lock --deployment-recovery; exec python3 "$RECOVERY_HELPER" "$@"',
			'deployment-recovery',
			...command,
		],
		{
			cwd,
			env: {
				...process.env,
				PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
				STARTERDOUGH_STATE_DIR: fixture.state,
				LOCK_HELPER: lockHelper,
				RECOVERY_HELPER: helper,
				DOCKER_LOG: fixture.log,
				RUNNING_PATH: fixture.running,
				...extra,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	return {
		child,
		code: child.exited,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
	};
}

async function waitForFile(path: string) {
	const deadline = Date.now() + 5_000;
	while (!(await Bun.file(path).exists())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await Bun.sleep(10);
	}
}

async function phase(value: Fixture) {
	return JSON.parse(await Bun.file(join(value.state, 'deployment-interrupted')).text()).phase;
}

async function run(fixtureValue: Fixture, command: string[], extra: Record<string, string> = {}) {
	const result = await invoke(fixtureValue, command, extra);
	return { code: await result.code, stdout: await result.stdout, stderr: await result.stderr };
}

async function begin(
	fixtureValue: Fixture,
	extra: Record<string, string> = {},
	project = 'starterdough',
	services = ['api'],
) {
	const result = await run(fixtureValue, ['begin', project, ...services], extra);
	if (result.code !== 0) throw new Error(result.stderr);
}

describe('deployment interruption journal', () => {
	it('recovers an interruption immediately after journaling and before writer stop', async () => {
		const value = await fixture();
		await begin(value);
		expect(await phase(value)).toBe('pre-replacement');

		const recovered = await run(value, ['recover']);
		expect(recovered).toMatchObject({ code: 0, stdout: 'deployment_recovery_complete\n' });
		const log = await Bun.file(value.log).text();
		expect(log).not.toContain('stop --time');
		expect(log).not.toContain(`start ${oldId}`);
		expect(log).not.toContain('compose up');
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(false);
	});

	it('restores validated old writers after a process is interrupted while stopping them', async () => {
		const value = await fixture();
		await begin(value);
		const barrier = join(value.root, 'stop-barrier');
		const stopping = await invoke(value, ['stop'], {
			BLOCK_STOP: '1',
			BLOCK_BARRIER: barrier,
		});
		await waitForFile(`${barrier}.entered`);
		stopping.child.kill('SIGKILL');
		expect(await stopping.code).not.toBe(0);
		expect(await phase(value)).toBe('pre-replacement');
		// The Docker child is now orphaned but still owns inherited operation-lock FD 8. A second
		// recovery must not overlap the still-running stop command.
		expect((await run(value, ['recover'])).code).not.toBe(0);
		await Bun.write(`${barrier}.release`, 'release\n');
		await waitForFile(`${barrier}.exited`);
		const recovered = await run(value, ['recover']);
		expect(recovered).toMatchObject({ code: 0, stdout: 'deployment_recovery_complete\n' });
		expect(await Bun.file(value.log).text()).toContain(`start ${oldId}`);
		expect(await Bun.file(value.log).text()).not.toContain('compose up');
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(false);
	});

	it('retains the forward-only phase through an interrupted candidate startup', async () => {
		const value = await fixture();
		await begin(value);
		expect((await run(value, ['stop'])).code).toBe(0);
		expect((await run(value, ['forward'])).code).toBe(0);
		const barrier = join(value.root, 'up-barrier');
		const recovering = await invoke(value, ['recover'], {
			BLOCK_UP: '1',
			BLOCK_BARRIER: barrier,
		});
		await waitForFile(`${barrier}.entered`);
		recovering.child.kill('SIGKILL');
		expect(await recovering.code).not.toBe(0);
		expect(await phase(value)).toBe('forward-only');
		expect((await run(value, ['recover'])).code).not.toBe(0);
		await Bun.write(`${barrier}.release`, 'release\n');
		await waitForFile(`${barrier}.exited`);
		const recovered = await run(value, ['recover']);
		expect(recovered.code).toBe(0);
		const log = await Bun.file(value.log).text();
		expect(log).toContain(
			'compose up -d --remove-orphans --wait --wait-timeout 180 --no-build --pull never',
		);
		expect(log).not.toContain(`start ${oldId}`);
	});

	it('retains forward-only recovery after migration startup succeeds but readiness fails', async () => {
		const value = await fixture();
		await begin(value);
		expect((await run(value, ['stop'])).code).toBe(0);
		expect((await run(value, ['forward'])).code).toBe(0);

		const failed = await run(value, ['recover'], { FAIL_READY: '1' });
		expect(failed.code).toBe(1);
		expect(await phase(value)).toBe('forward-only');
		expect(await Bun.file(value.log).text()).not.toContain(`start ${oldId}`);

		expect((await run(value, ['recover'])).code).toBe(0);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(false);
	});

	it('rejects changed old writer identities before restarting any writer', async () => {
		const value = await fixture();
		await begin(value);
		expect((await run(value, ['stop'])).code).toBe(0);
		const recovered = await run(value, ['recover'], { CHANGED_OLD_IMAGE: '1' });
		expect(recovered.code).toBe(1);
		expect(await Bun.file(value.log).text()).not.toContain(`start ${oldId}`);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(true);
	});

	it('rejects malformed and symbolic-link journals without Docker mutation', async () => {
		for (const kind of ['malformed', 'symlink'] as const) {
			const value = await fixture();
			const journal = join(value.state, 'deployment-interrupted');
			if (kind === 'malformed') await Bun.write(journal, '{not-json\n');
			else await symlink(join(value.root, 'missing-journal'), journal);

			const before = await Bun.file(value.log).text();
			const recovered = await run(value, ['recover']);
			expect(recovered.code).toBe(1);
			expect(await Bun.file(value.log).text()).toBe(before);
			expect(await Bun.file(journal).exists()).toBe(kind === 'malformed');
		}
	});

	it('refuses revision, configuration, image, and checkout drift in forward-only recovery', async () => {
		const cases = [
			{ name: 'revision', extra: { CURRENT_REVISION: 'f'.repeat(40) } },
			{ name: 'configuration', extra: { CONFIG_VARIANT: 'changed' } },
			{ name: 'image', extra: { CANDIDATE_IMAGE_ID: `sha256:${'f'.repeat(64)}` } },
		] as const;

		for (const testCase of cases) {
			const value = await fixture();
			await begin(value);
			expect((await run(value, ['stop'])).code).toBe(0);
			expect((await run(value, ['forward'])).code).toBe(0);
			const before = await Bun.file(value.log).text();
			const recovered = await run(value, ['recover'], testCase.extra);
			expect(recovered.code, testCase.name).toBe(1);
			expect(await phase(value), testCase.name).toBe('forward-only');
			const changed = (await Bun.file(value.log).text()).slice(before.length);
			expect(changed, testCase.name).not.toContain('compose up');
			expect(changed, testCase.name).not.toContain(`start ${oldId}`);
		}

		const value = await fixture();
		await begin(value);
		expect((await run(value, ['stop'])).code).toBe(0);
		expect((await run(value, ['forward'])).code).toBe(0);
		const otherCheckout = join(value.root, 'other-checkout');
		await mkdir(otherCheckout);
		const recovered = await invoke(value, ['recover'], {}, otherCheckout);
		expect(await recovered.code).toBe(1);
		expect(await phase(value)).toBe('forward-only');
	}, 20_000);

	it('serializes recovery and blocks normal operations while a journal exists', async () => {
		const value = await fixture();
		await begin(value);
		const barrier = join(value.root, 'lock-barrier');
		const holder = Bun.spawn(
			[
				'python3',
				'-c',
				`import fcntl, os, time
lock = open(os.path.join(os.environ['STARTERDOUGH_STATE_DIR'], 'operations.lock'), 'w')
fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
barrier = os.environ['BLOCK_BARRIER']
open(barrier + '.entered', 'w').close()
while not os.path.exists(barrier + '.release'): time.sleep(0.01)
`,
			],
			{
				cwd: value.root,
				env: {
					...process.env,
					STARTERDOUGH_STATE_DIR: value.state,
					BLOCK_BARRIER: barrier,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		await waitForFile(`${barrier}.entered`);

		expect((await run(value, ['recover'])).code).not.toBe(0);
		const normal = Bun.spawnSync(['bash', '-c', 'source "$LOCK_HELPER"; acquire_operation_lock'], {
			cwd: value.root,
			env: {
				...process.env,
				STARTERDOUGH_STATE_DIR: value.state,
				LOCK_HELPER: lockHelper,
			},
		});
		expect(normal.exitCode).not.toBe(0);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(true);

		await Bun.write(`${barrier}.release`, 'release\n');
		expect(await holder.exited).toBe(0);
	});

	it('persists forward-only before returning from first-boot begin and recovers directly', async () => {
		const value = await fixture();
		const extra = { NO_WRITERS: '1' };
		await begin(value, extra);
		expect(await phase(value)).toBe('forward-only');
		expect((await run(value, ['stop'], extra)).code).toBe(0);
		expect((await run(value, ['forward'], extra)).code).toBe(0);
		expect((await run(value, ['recover'], extra)).code).toBe(0);
		const mutations = (await Bun.file(value.log).text())
			.split('\n')
			.filter((line) => line.startsWith('stop ') || line.startsWith('start '));
		expect(mutations).toEqual([]);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(false);
	});

	it('records and stops only the demo API writer', async () => {
		const value = await fixture();
		const extra = { PROJECT: 'starterdough-demo' };
		await begin(value, extra, 'starterdough-demo', ['demo-api']);
		expect((await run(value, ['stop'], extra)).code).toBe(0);
		const mutations = (await Bun.file(value.log).text())
			.split('\n')
			.filter((line) => line.startsWith('stop ') || line.startsWith('start '));
		expect(mutations).toEqual([`stop --time 120 ${oldId}`]);
	});

	it('refuses inventory failures without writer mutation', async () => {
		const value = await fixture();
		const result = await run(value, ['begin', 'starterdough', 'api'], { INVENTORY_FAILURE: '1' });
		expect(result.code).toBe(1);
		const mutations = (await Bun.file(value.log).text())
			.split('\n')
			.filter((line) => line.startsWith('stop ') || line.startsWith('start '));
		expect(mutations).toEqual([]);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(false);
	});

	it('accepts every immutable API replica when the target scales APIs', async () => {
		const value = await fixture();
		const target = { SCALED_API: '1' };
		await begin(value, target);
		expect((await run(value, ['stop'], target)).code).toBe(0);
		expect((await run(value, ['forward'], target)).code).toBe(0);
		expect((await run(value, ['recover'], target)).code).toBe(0);
		const log = await Bun.file(value.log).text();
		expect(log).toContain(`inspect ${candidateId}`);
		expect(log).toContain(`inspect ${scaledApiId}`);
	});

	it('retains the journal when any scaled API replica has a different image', async () => {
		const value = await fixture();
		const target = { SCALED_API: '1' };
		await begin(value, target);
		expect((await run(value, ['stop'], target)).code).toBe(0);
		expect((await run(value, ['forward'], target)).code).toBe(0);
		expect((await run(value, ['recover'], { ...target, BAD_SCALED_API: '1' })).code).toBe(1);
		expect(await Bun.file(join(value.state, 'deployment-interrupted')).exists()).toBe(true);
	});
});
