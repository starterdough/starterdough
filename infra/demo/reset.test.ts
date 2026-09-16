import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const reset = resolve(import.meta.dir, 'reset.sh');
const lock = resolve(import.meta.dir, '../scripts/operation-lock.sh');
const recovery = resolve(import.meta.dir, '../scripts/deployment-recovery.sh');
const revision = '1234567890abcdef1234567890abcdef12345678';
const imageId = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'starterdough-demo-reset-'));
	roots.push(root);
	const bin = join(root, 'bin');
	const state = join(root, 'state');
	const log = join(root, 'docker.log');
	await Promise.all([
		mkdir(bin),
		mkdir(state),
		mkdir(join(root, 'infra/demo'), { recursive: true }),
		mkdir(join(root, 'infra/scripts'), { recursive: true }),
	]);
	await Promise.all([
		Bun.write(join(root, '.env'), 'COMPOSE_FILE=infra/compose.yml\n'),
		Bun.write(log, ''),
		copyFile(reset, join(root, 'infra/demo/reset.sh')),
		copyFile(lock, join(root, 'infra/scripts/operation-lock.sh')),
		copyFile(recovery, join(root, 'infra/scripts/deployment-recovery.sh')),
	]);
	await Bun.write(
		join(root, 'docker.py'),
		`#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_LOG'], 'a', encoding='utf-8') as handle:
    handle.write(' '.join(args) + '\\n')
if args[:2] == ['compose', 'config'] and '--format' not in args and '--services' not in args:
    print('name: starterdough-demo')
elif args[:3] == ['compose', 'config', '--services']:
    sys.stdout.write('demo-api\\n' + ('fixture-service\\n' * 8192))
elif args[:4] == ['compose', 'config', '--format', 'json']:
    print(json.dumps({'name': 'starterdough-demo', 'services': {'demo-api': {'image': 'registry.invalid/demo-api:target'}}}))
elif args[:5] == ['compose', 'ps', '-a', '-q', 'demo-api']:
    print('${'b'.repeat(64)}')
elif args[:2] == ['image', 'inspect']:
    template = args[3]
    print(os.environ.get('IMAGE_REVISION', '${revision}') if 'org.opencontainers' in template else '${imageId}')
elif args[:1] == ['inspect']:
    template = args[2]
    sys.stdout.write(
        ('PUBLIC_DEMO_MODE=true\\n' + ('fixture-env\\n' * 8192))
        if 'Config.Env' in template
        else os.environ.get('RUNNING_IMAGE_ID', '${imageId}') + '\\n'
    )
elif args[:2] == ['compose', 'stop'] or args[:2] == ['compose', 'exec'] or args[:2] == ['compose', 'up']:
    pass
else:
    raise SystemExit(90)
`,
	);
	await Promise.all([
		Bun.write(join(bin, 'docker'), `#!/bin/sh\nexec python3 "${join(root, 'docker.py')}" "$@"\n`),
		Bun.write(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${revision}'\n`),
		Bun.write(
			join(bin, 'flock'),
			`#!/usr/bin/env python3
import fcntl, sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | (fcntl.LOCK_NB if '-n' in sys.argv else 0))
`,
		),
	]);
	await Promise.all(['docker', 'git', 'flock'].map((name) => chmod(join(bin, name), 0o700)));
	return { root, state, log, bin, reset: join(root, 'infra/demo/reset.sh') };
}

async function run(value: Awaited<ReturnType<typeof fixture>>, extra: Record<string, string> = {}) {
	const child = Bun.spawn(['bash', value.reset], {
		cwd: value.root,
		env: {
			...process.env,
			PATH: `${value.bin}:${process.env.PATH ?? ''}`,
			STARTERDOUGH_STATE_DIR: value.state,
			DOCKER_LOG: value.log,
			...extra,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: await child.exited, stderr: await new Response(child.stderr).text() };
}

describe('demo reset identity fence', () => {
	it('blocks a pending deployment journal before Docker', async () => {
		const value = await fixture();
		await Bun.write(join(value.state, 'deployment-interrupted'), '{}\n');
		const result = await run(value);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('deployment recovery is pending');
		expect(await Bun.file(value.log).text()).toBe('');
	});

	it.each([
		['mismatched image label', 'f'.repeat(40), imageId, 'demo-api image revision'],
		['mismatched resolved image', revision, `sha256:${'c'.repeat(64)}`, 'running demo-api image'],
	])(
		'%s refuses before stopping writers',
		async (_name, imageRevision, runningImageId, diagnostic) => {
			const value = await fixture();
			const result = await run(value, {
				IMAGE_REVISION: imageRevision,
				RUNNING_IMAGE_ID: runningImageId,
			});
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(diagnostic);
			const log = (await Bun.file(value.log).text()).split('\n');
			expect(log.some((line) => line.startsWith('compose stop'))).toBe(false);
			expect(log.some((line) => line.startsWith('compose exec'))).toBe(false);
		},
	);

	it('allows a matching managed image and a label-less local image only when image identities match', async () => {
		const managed = await fixture();
		expect(await run(managed, { IMAGE_REVISION: revision })).toMatchObject({ code: 0 });
		expect(await Bun.file(managed.log).text()).toContain('compose stop demo-web demo-api');

		const local = await fixture();
		expect(await run(local, { IMAGE_REVISION: '' })).toMatchObject({ code: 0 });
		expect(await Bun.file(local.log).text()).toContain('compose stop demo-web demo-api');
	});
});
