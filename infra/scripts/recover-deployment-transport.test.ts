import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../..');

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function step(file: string, job: string, name: string) {
	const workflow: unknown = Bun.YAML.parse(
		await Bun.file(join(repository, '.github/workflows', file)).text(),
	);
	if (!record(workflow) || !record(workflow.jobs)) throw new Error('Missing jobs');
	const selected = workflow.jobs[job];
	if (!record(selected) || !Array.isArray(selected.steps)) throw new Error('Missing steps');
	const found = selected.steps.find(
		(value): value is Record<string, unknown> => record(value) && value.name === name,
	);
	if (!found || typeof found.run !== 'string') throw new Error(`Missing step: ${name}`);
	return found.run;
}

async function fixture(run: (root: string, bin: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), 'starterdough-recovery-transport-'));
	try {
		const bin = join(root, 'bin');
		await Promise.all([
			mkdir(bin),
			mkdir(join(root, 'state')),
			mkdir(join(root, 'runner')),
			mkdir(join(root, 'infra/scripts'), { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
			writeFile(join(root, '.env'), 'UNCHANGED=1\n'),
			...['git', 'docker'].map((command) =>
				writeFile(join(bin, command), '#!/bin/sh\ntouch "$MUTATION_CALLED"\nexit 97\n', {
					mode: 0o700,
				}),
			),
			writeFile(join(bin, 'ssh'), '#!/bin/bash\nfor last do :; done\nexec bash -c "$last"\n', {
				mode: 0o700,
			}),
		]);
		await run(root, bin);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function execute(
	root: string,
	bin: string,
	script: string,
	extra: Record<string, string> = {},
) {
	const child = Bun.spawn(['bash', '-c', script], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ''}`,
			STARTERDOUGH_STATE_DIR: join(root, 'state'),
			RUNNER_TEMP: join(root, 'runner'),
			DEPLOY_PATH: root,
			DEMO_PATH: root,
			DEPLOY_HOST: 'host.invalid',
			DEPLOY_USER: 'deploy',
			DEPLOY_SSH_KEY: 'synthetic-fixture-key',
			GIT_REF: '1234567890abcdef1234567890abcdef12345678',
			IMAGE_TAG: 'sha-1234567',
			IMAGE_REGISTRY: 'registry.invalid/fixture',
			MUTATION_CALLED: join(root, 'mutation-called'),
			RECOVERY_ACTION: 'status',
			RECOVERY_TARGET: 'production',
			...extra,
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

describe('deployment recovery workflow fences', () => {
	it('finishes the guarded demo update before replacing production under the same lock', async () => {
		await fixture(async (root, bin) => {
			const demo = join(root, 'demo');
			const calls = join(root, 'calls');
			await mkdir(join(demo, 'infra/demo'), { recursive: true });
			await Promise.all([
				writeFile(
					join(bin, 'git'),
					`#!/bin/sh
case "$1" in
  cat-file) exit 0 ;;
  show) printf '%s\\n' 'deployment-recovery.sh'; exit 0 ;;
esac
printf "git %s\\n" "$*" >> "$CALLS"
`,
					{
						mode: 0o700,
					},
				),
				writeFile(
					join(demo, 'infra/demo/update.sh'),
					'#!/bin/bash\nset -euo pipefail\n[ "$STARTERDOUGH_OPERATION_LOCK_HELD" = 1 ]\npython3 -c "import os; os.fstat(8)"\necho demo-update >> "$CALLS"\n',
				),
				writeFile(
					join(root, 'infra/scripts/deploy.sh'),
					'#!/bin/bash\nset -euo pipefail\n[ "$STARTERDOUGH_OPERATION_LOCK_HELD" = 1 ]\npython3 -c "import os; os.fstat(8)"\necho production-deploy >> "$CALLS"\n',
				),
				writeFile(
					join(root, 'infra/scripts/operation-lock.sh'),
					'#!/bin/sh\nacquire_operation_lock() { return 0; }\n',
				),
			]);
			const result = await execute(root, bin, await step('deploy.yml', 'deploy', 'Deploy'), {
				DEMO_PATH: demo,
				CALLS: calls,
			});
			expect(result.code).toBe(0);
			const operations = (await readFile(calls, 'utf8')).trim().split('\n');
			expect(operations).toEqual([
				'git fetch --quiet origin',
				`git -C ${demo} fetch --quiet origin`,
				`git -C ${demo} checkout --quiet --detach 1234567890abcdef1234567890abcdef12345678`,
				'demo-update',
				'git checkout --quiet --detach 1234567890abcdef1234567890abcdef12345678',
				'production-deploy',
			]);
		});
	});

	it('deploys production without demo files when DEMO_PATH is unset', async () => {
		await fixture(async (root, bin) => {
			const calls = join(root, 'calls');
			await Promise.all([
				writeFile(
					join(bin, 'git'),
					`#!/bin/sh
case "$1" in
  cat-file) exit 0 ;;
  show) printf '%s\\n' 'deployment-recovery.sh'; exit 0 ;;
esac
printf "git %s\\n" "$*" >> "$CALLS"
`,
					{ mode: 0o700 },
				),
				writeFile(
					join(root, 'infra/scripts/deploy.sh'),
					'#!/bin/bash\nset -euo pipefail\necho production-deploy >> "$CALLS"\n',
				),
				writeFile(
					join(root, 'infra/scripts/operation-lock.sh'),
					'#!/bin/sh\nacquire_operation_lock() { return 0; }\n',
				),
			]);
			const result = await execute(root, bin, await step('deploy.yml', 'deploy', 'Deploy'), {
				DEMO_PATH: '',
				CALLS: calls,
			});
			expect(result.code).toBe(0);
			expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([
				'git fetch --quiet origin',
				'git checkout --quiet --detach 1234567890abcdef1234567890abcdef12345678',
				'production-deploy',
			]);
		});
	});

	it('refuses a target without the recovery contract before either checkout or updater', async () => {
		await fixture(async (root, bin) => {
			const demo = join(root, 'demo');
			const calls = join(root, 'calls');
			await mkdir(join(demo, 'infra/demo'), { recursive: true });
			await Promise.all([
				writeFile(
					join(bin, 'git'),
					`#!/bin/sh
if [ "$1" = cat-file ]; then exit 1; fi
printf "git %s\\n" "$*" >> "$CALLS"
`,
					{ mode: 0o700 },
				),
				writeFile(join(demo, 'infra/demo/update.sh'), 'touch "$MUTATION_CALLED"\n'),
				writeFile(join(root, 'infra/scripts/deploy.sh'), 'touch "$MUTATION_CALLED"\n'),
			]);
			const result = await execute(root, bin, await step('deploy.yml', 'deploy', 'Deploy'), {
				DEMO_PATH: demo,
				CALLS: calls,
			});
			expect(result.code).not.toBe(0);
			expect(await readFile(calls, 'utf8')).toBe('git fetch --quiet origin\n');
			expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
		});
	});

	for (const name of ['Refuse a new release while deployment recovery is pending', 'Deploy']) {
		it.each(['file', 'dangling symlink'])(
			`${name} refuses a journal %s before Git or Docker`,
			async (kind) => {
				await fixture(async (root, bin) => {
					const journal = join(root, 'state/deployment-interrupted');
					if (kind === 'file') await writeFile(journal, 'unresolved');
					else await symlink(join(root, 'missing'), journal);
					const result = await execute(root, bin, await step('deploy.yml', 'deploy', name));
					expect(result.code).not.toBe(0);
					expect(result.stderr).toContain('deployment recovery is pending');
					expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
					expect(await readFile(join(root, '.env'), 'utf8')).toBe('UNCHANGED=1\n');
				});
			},
		);
	}
});

describe('explicit deployment recovery transport', () => {
	const name = 'Recover the recorded deployment without changing its checkout';
	it.each([
		['status', 'deployment_recovery_pending=false', '0', 0],
		['status', 'deployment_recovery_pending=true', '0', 0],
		['recover', 'deployment_recovery_complete', '0', 0],
		['recover', 'incomplete', '0', 1],
		['status', 'incomplete', '0', 1],
		['recover', 'deployment_recovery_complete', '7', 7],
	])(
		'forwards %s and requires success plus its marker (%s, exit %s)',
		async (action, output, exit, expected) => {
			await fixture(async (root, bin) => {
				await writeFile(
					join(root, 'infra/scripts/recover-deployment.sh'),
					`#!/bin/bash\nset -euo pipefail\n[ "$1" = '${action}' ]\n[ -z "$(cat)" ]\nprintf '%s\\n' '${output}'\nexit ${exit}\n`,
				);
				const result = await execute(
					root,
					bin,
					await step('recover-deployment.yml', 'recovery', name),
					{ RECOVERY_ACTION: action },
				);
				expect(result.code).toBe(expected);
				expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
				expect(await Bun.file(join(root, 'runner/deployment-recovery-key')).exists()).toBe(false);
			});
		},
	);

	it('quotes the selected demo checkout and never uses the production checkout', async () => {
		await fixture(async (root, bin) => {
			const demo = join(root, "demo's checkout");
			await mkdir(join(demo, 'infra/scripts'), { recursive: true });
			await writeFile(
				join(demo, 'infra/scripts/recover-deployment.sh'),
				'#!/bin/sh\necho deployment_recovery_pending=false\n',
			);
			const result = await execute(
				root,
				bin,
				await step('recover-deployment.yml', 'recovery', name),
				{ RECOVERY_TARGET: 'demo', DEMO_PATH: demo },
			);
			expect(result.code).toBe(0);
		});
	});
});
