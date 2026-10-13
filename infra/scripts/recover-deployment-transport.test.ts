import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { standInForGitHook, withoutGit } from '../../scripts/git-hook-stand-in';

const repository = resolve(import.meta.dir, '../..');

// The cases run workflow steps in bash against ssh, git and docker shims, some with real git, and a
// loaded machine runs them many times slower than an idle one. Set here, the budget also covers
// `bun test <this file>` without the root `test` script's `--timeout` (see
// deployment-recovery.test.ts).
setDefaultTimeout(60_000);

// Several cases below drive real git; under lefthook's pre-push hook, inherited GIT_* variables
// would point it at the repository being pushed. Every spawn here starts from `withoutGit()`.
standInForGitHook();

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function steps(file: string, job: string) {
	const workflow: unknown = Bun.YAML.parse(
		await Bun.file(join(repository, '.github/workflows', file)).text(),
	);
	if (!record(workflow) || !record(workflow.jobs)) throw new Error('Missing jobs');
	const selected = workflow.jobs[job];
	if (!record(selected) || !Array.isArray(selected.steps)) throw new Error('Missing steps');
	return selected.steps.filter((value): value is Record<string, unknown> => record(value));
}

async function step(file: string, job: string, name: string) {
	const found = (await steps(file, job)).find((value) => value.name === name);
	if (!found || typeof found.run !== 'string') throw new Error(`Missing step: ${name}`);
	return found.run;
}

/** Shell for a docker shim's `compose config`: a checkout named `demo` runs the demo's project. */
const projectByCheckout =
	'case "$PWD" in */demo) echo "name: starterdough-demo" ;; *) echo "name: starterdough" ;; esac';

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
			writeFile(join(bin, 'git'), '#!/bin/sh\ntouch "$MUTATION_CALLED"\nexit 97\n', {
				mode: 0o700,
			}),
			// Reading the Compose project changes nothing; anything else asked of Docker is a mutation.
			// A checkout named `demo` runs the demo's project, any other production's.
			writeFile(
				join(bin, 'docker'),
				`#!/bin/sh\n[ "$*" = "compose config" ] && { ${projectByCheckout}; exit 0; }\ntouch "$MUTATION_CALLED"\nexit 97\n`,
				{ mode: 0o700 },
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
			...withoutGit(),
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
			EXPECTED_PROJECT: 'starterdough',
			EXPECTED_DEMO_PROJECT: 'starterdough-demo',
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
			// The server never fetches; the refusal comes before any checkout.
			expect(await Bun.file(calls).exists()).toBe(false);
			expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
		});
	});

	const guard = "Refuse a checkout that is not this product's";

	it('lets a checkout of this repository that runs this project through, demo included', async () => {
		await fixture(async (root, bin) => {
			const calls = join(root, 'calls');
			await mkdir(join(root, 'demo'));
			await writeFile(
				join(bin, 'git'),
				'#!/bin/sh\nprintf "git %s\\n" "$*" >> "$CALLS"\ncase "$*" in "merge-base HEAD "*|"-C "*" merge-base HEAD "*) exit 0 ;; esac\nexit 97\n',
				{ mode: 0o700 },
			);
			const result = await execute(root, bin, await step('deploy.yml', 'deploy', guard), {
				DEMO_PATH: join(root, 'demo'),
				CALLS: calls,
			});
			expect(result.code, result.stderr).toBe(0);
			expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([
				'git merge-base HEAD 1234567890abcdef1234567890abcdef12345678',
				`git -C ${join(root, 'demo')} merge-base HEAD 1234567890abcdef1234567890abcdef12345678`,
			]);
			expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
		});
	});

	it('refuses a checkout of another repository, or of another Compose project, before touching it', async () => {
		for (const [name, production, demo, project, message] of [
			['unrelated history', 1, 0, 'starterdough', 'shares no history with this repository'],
			[
				'another project',
				0,
				0,
				'otherproduct',
				"runs Compose project 'otherproduct', not 'starterdough'",
			],
			['no project at all', 0, 0, '', "runs Compose project 'none'"],
			['an unrelated demo checkout', 0, 1, 'starterdough', 'DEMO_PATH names another checkout'],
		] as const) {
			await fixture(async (root, bin) => {
				const calls = join(root, 'calls');
				await Promise.all([
					writeFile(
						join(bin, 'git'),
						`#!/bin/sh\nif [ "$1" = merge-base ]; then exit ${production}; fi\nif [ "$1" = -C ] && [ "$3" = merge-base ]; then exit ${demo}; fi\nprintf "git %s\\n" "$*" >> "$CALLS"\n`,
						{ mode: 0o700 },
					),
					writeFile(
						join(bin, 'docker'),
						`#!/bin/sh\nif [ "$*" = "compose config" ]; then ${project ? `echo "name: ${project}"` : 'exit 1'}; exit 0; fi\ntouch "$MUTATION_CALLED"\n`,
						{ mode: 0o700 },
					),
				]);
				const result = await execute(root, bin, await step('deploy.yml', 'deploy', guard), {
					DEMO_PATH: join(root, 'demo'),
					CALLS: calls,
				});
				expect(result.code, name).not.toBe(0);
				expect(result.stderr, name).toContain(message);
				expect(await Bun.file(calls).exists(), name).toBe(false);
				expect(await Bun.file(join(root, 'mutation-called')).exists(), name).toBe(false);
				expect(await readFile(join(root, '.env'), 'utf8'), name).toBe('UNCHANGED=1\n');
			});
		}
	});

	it('sits between delivery and the environment file, so a refusal ships no .env', async () => {
		const deploy = await steps('deploy.yml', 'deploy');
		const names = deploy.map((value) => value.name);
		const at = (name: string) => {
			const index = names.indexOf(name);
			if (index === -1) throw new Error(`Missing step: ${name}`);
			return index;
		};
		const deliver = at('Deliver the release commit to the server');
		const sops = at('Ship the environment file (only when SOPS_AGE_KEY is set)');
		expect(at(guard)).toBe(deliver + 1);
		expect(at(guard)).toBeLessThan(sops);
		expect(sops).toBeLessThan(at('Deploy'));
		// The project the guard checks is settled before it, from the release itself.
		const project = deploy.findIndex((value) => value.id === 'project');
		expect(project).toBeGreaterThan(-1);
		expect(project).toBeLessThan(at(guard));
		// A failed guard stops the job: nothing up to the Deploy step may carry on regardless.
		for (const value of deploy.slice(at(guard), at('Deploy') + 1)) {
			expect(value['continue-on-error'], String(value.name)).toBeUndefined();
			expect(String(value.if ?? ''), String(value.name)).not.toMatch(/always\(\)|failure\(\)/);
		}
	});

	it('works out the project from the release, or from COMPOSE_PROJECT_NAME', async () => {
		const run = await step(
			'deploy.yml',
			'deploy',
			'The Compose project this release expects on the server',
		);
		for (const [variable, compose, code, expected] of [
			['', 'name: lumen', 0, 'name=lumen'],
			['legacy-name', 'name: lumen', 0, 'name=legacy-name'],
			['', '', 1, ''],
			['', 'name: "lumen"', 1, ''],
			['Lumen', 'name: lumen', 1, ''],
			["x' && touch y '", 'name: lumen', 1, ''],
		] as const) {
			await fixture(async (root, bin) => {
				await writeFile(
					join(bin, 'git'),
					`#!/bin/sh\n[ "$*" = "show 1234567890abcdef1234567890abcdef12345678:infra/compose.yml" ] || exit 1\nprintf '%s\\n' '# comment' '${compose}' 'services:'\n`,
					{ mode: 0o700 },
				);
				const output = join(root, 'output');
				await writeFile(output, '');
				const result = await execute(root, bin, run, {
					COMPOSE_PROJECT: variable,
					GITHUB_OUTPUT: output,
					DEMO_PATH: '',
				});
				expect(result.code, `${variable} ${compose}`).toBe(code);
				expect((await readFile(output, 'utf8')).trim(), `${variable} ${compose}`).toBe(expected);
			});
		}
	});

	it("works out the demo's project from the release's demo stack, when DEMO_PATH is set", async () => {
		const run = await step(
			'deploy.yml',
			'deploy',
			'The Compose project this release expects on the server',
		);
		for (const [demoPath, demoCompose, code, expected] of [
			['/opt/demo', 'name: lumen-demo', 0, 'name=lumen\ndemo=lumen-demo'],
			['', 'name: lumen-demo', 0, 'name=lumen'],
			['/opt/demo', '', 1, 'name=lumen'],
			['/opt/demo', "name: x'; touch y; '", 1, 'name=lumen'],
		] as const) {
			await fixture(async (root, bin) => {
				await writeFile(
					join(bin, 'git'),
					`#!/bin/sh
case "$*" in
  "show 1234567890abcdef1234567890abcdef12345678:infra/compose.yml") echo 'name: lumen' ;;
  "show 1234567890abcdef1234567890abcdef12345678:infra/demo/compose.yml") printf '%s\\n' "$DEMO_COMPOSE" ;;
  *) exit 1 ;;
esac
`,
					{ mode: 0o700 },
				);
				const output = join(root, 'output');
				await writeFile(output, '');
				const result = await execute(root, bin, run, {
					DEMO_PATH: demoPath,
					DEMO_COMPOSE: demoCompose,
					GITHUB_OUTPUT: output,
				});
				expect(result.code, `${demoPath} ${demoCompose}`).toBe(code);
				expect((await readFile(output, 'utf8')).trim(), demoCompose).toBe(expected);
			});
		}
	});

	it('refuses a DEMO_PATH that runs another Compose project before anything checks it out', async () => {
		// Production's own checkout, pasted as DEMO_PATH, shares the history and runs the wrong
		// project; another kit-based product's checkout does the same.
		for (const name of [guard, 'Deploy']) {
			await fixture(async (root, bin) => {
				const calls = join(root, 'calls');
				const demo = join(root, 'demo');
				await mkdir(join(demo, 'infra/demo'), { recursive: true });
				await Promise.all([
					writeFile(
						join(bin, 'git'),
						`#!/bin/sh
case "$*" in
  "cat-file "*|"merge-base "*|"-C "*" merge-base "*) exit 0 ;;
  "show "*) printf '%s\\n' 'deployment-recovery.sh'; exit 0 ;;
esac
printf "git %s\\n" "$*" >> "$CALLS"
`,
						{ mode: 0o700 },
					),
					writeFile(join(demo, 'infra/demo/update.sh'), 'touch "$MUTATION_CALLED"\n'),
					writeFile(join(root, 'infra/scripts/deploy.sh'), 'touch "$MUTATION_CALLED"\n'),
				]);
				for (const demoPath of [root, demo]) {
					const result = await execute(root, bin, await step('deploy.yml', 'deploy', name), {
						DEMO_PATH: demoPath,
						EXPECTED_DEMO_PROJECT: demoPath === root ? 'starterdough-demo' : 'otherproduct-demo',
						CALLS: calls,
					});
					expect(result.code, `${name} ${demoPath}`).not.toBe(0);
					expect(result.stderr, name).toContain(`${demoPath} runs Compose project`);
					expect(await Bun.file(calls).exists(), name).toBe(false);
					expect(await Bun.file(join(root, 'mutation-called')).exists(), name).toBe(false);
				}
			});
		}
	});

	it('Deploy refuses a checkout whose .env now names another project, before anything moves', async () => {
		await fixture(async (root, bin) => {
			const demo = join(root, 'demo');
			const calls = join(root, 'calls');
			await mkdir(join(demo, 'infra/demo'), { recursive: true });
			await Promise.all([
				writeFile(join(bin, 'git'), '#!/bin/sh\nprintf "git %s\\n" "$*" >> "$CALLS"\nexit 0\n', {
					mode: 0o700,
				}),
				writeFile(
					join(bin, 'docker'),
					'#!/bin/sh\n[ "$*" = "compose config" ] && { echo "name: renamed"; exit 0; }\ntouch "$MUTATION_CALLED"\n',
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
			expect(result.stderr).toContain("now runs Compose project 'renamed', not 'starterdough'");
			expect(await Bun.file(calls).exists()).toBe(false);
			expect(await Bun.file(join(root, 'mutation-called')).exists()).toBe(false);
		});
	});

	for (const name of [guard, 'Deploy']) {
		it(`${name} refuses an expected project it would quote unsafely, before connecting`, async () => {
			for (const project of ["x'; touch y; '", 'Lumen', '']) {
				await fixture(async (root, bin) => {
					// Any connection at all is too late: the value would already be in the remote script.
					await writeFile(join(bin, 'ssh'), '#!/bin/sh\ntouch "$MUTATION_CALLED"\nexit 0\n', {
						mode: 0o700,
					});
					const result = await execute(root, bin, await step('deploy.yml', 'deploy', name), {
						EXPECTED_PROJECT: project,
					});
					expect(result.code, project).not.toBe(0);
					expect(result.stderr, project).toContain('invalid project');
					expect(await Bun.file(join(root, 'mutation-called')).exists(), project).toBe(false);
				});
			}
		});
	}

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

	it('forwards abandon with its confirmation, and passes nothing else one', async () => {
		for (const [action, confirm, expected] of [
			['abandon', '1234567', '1234567'],
			[
				'abandon',
				'1234567890abcdef1234567890abcdef12345678',
				'1234567890abcdef1234567890abcdef12345678',
			],
			['status', '1234567', ''],
			['recover', '1234567', ''],
		] as const) {
			await fixture(async (root, bin) => {
				const marker = {
					abandon: 'deployment_recovery_abandoned',
					status: 'deployment_recovery_pending=true',
					recover: 'deployment_recovery_complete',
				}[action];
				await writeFile(
					join(root, 'infra/scripts/recover-deployment.sh'),
					`#!/bin/bash\nset -euo pipefail\n[ "$#" = 2 ] && [ "$1" = '${action}' ] && [ "$2" = '${expected}' ]\necho '${marker}'\n`,
				);
				const result = await execute(
					root,
					bin,
					await step('recover-deployment.yml', 'recovery', name),
					{
						RECOVERY_ACTION: action,
						RECOVERY_CONFIRM: confirm,
					},
				);
				expect(result.code, `${action} ${confirm}`).toBe(0);
			});
		}
	});

	it('refuses abandon without a revision prefix before connecting', async () => {
		for (const confirm of ['', '123456', '123456g', "1234567'; touch x; '", 'HEAD~1']) {
			await fixture(async (root, bin) => {
				await writeFile(join(bin, 'ssh'), '#!/bin/sh\ntouch "$MUTATION_CALLED"\n', { mode: 0o700 });
				const result = await execute(
					root,
					bin,
					await step('recover-deployment.yml', 'recovery', name),
					{
						RECOVERY_ACTION: 'abandon',
						RECOVERY_CONFIRM: confirm,
					},
				);
				expect(result.code, confirm).toBe(1);
				expect(result.stdout, confirm).toContain('::error title=No confirmation::');
				expect(await Bun.file(join(root, 'mutation-called')).exists(), confirm).toBe(false);
			});
		}
	});

	it('requires the abandon marker, not just a clean exit', async () => {
		await fixture(async (root, bin) => {
			await writeFile(
				join(root, 'infra/scripts/recover-deployment.sh'),
				"#!/bin/bash\necho 'usage: recover-deployment.sh [status|recover]' >&2\necho deployment_recovery_complete\n",
			);
			const result = await execute(
				root,
				bin,
				await step('recover-deployment.yml', 'recovery', name),
				{
					RECOVERY_ACTION: 'abandon',
					RECOVERY_CONFIRM: '1234567',
				},
			);
			expect(result.code).toBe(1);
		});
	});

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

// Real Git from here on, isolated from whoever runs the tests: no inherited GIT_* (see the top of
// the file), no global or system config (a signing or hook setting there would change what these
// commits do), a fixed identity, local repositories only and never a credential prompt.
const gitEnv = {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_NAME: 'Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_ALLOW_PROTOCOL: 'file',
	GIT_TERMINAL_PROMPT: '0',
};

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...withoutGit(), ...gitEnv },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

async function commit(repo: string, files: Record<string, string>, message: string) {
	await Promise.all(
		Object.entries(files).map(async ([path, text]) => {
			await mkdir(join(repo, path, '..'), { recursive: true });
			await writeFile(join(repo, path), text);
		}),
	);
	await git(repo, 'add', '--all');
	await git(repo, 'commit', '--quiet', '-m', message);
	return git(repo, 'rev-parse', 'HEAD');
}

/**
 * The cases below that drive real git (a clone, several commits, pushes into server checkouts) take
 * about 2 s on a quiet machine and have timed out at bun's default 5 s under load, like the
 * subprocess tests in deployment-recovery.test.ts.
 */
const GIT_TIMEOUT = 20_000;

describe('release plan', () => {
	const head = 'a'.repeat(40);
	const older = 'b'.repeat(40);

	async function plan(env: Record<string, string>, ci = '1', cwd?: string) {
		const root = await mkdtemp(join(tmpdir(), 'starterdough-release-plan-'));
		try {
			const bin = join(root, 'bin');
			await mkdir(bin);
			// Record every question. The tip of main is MAIN_TIP from the environment (main's real tip,
			// whatever GITHUB_SHA says); the CI lookup answers with the run count under test.
			await writeFile(
				join(bin, 'gh'),
				`#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, 'gh-calls')}"\ncase "$*" in\n*/commits/main*) printf '%s\\n' "$MAIN_TIP" ;;\n*) printf '%s\\n' '${ci}' ;;\nesac\n`,
				{ mode: 0o700 },
			);
			await writeFile(join(root, 'output'), '');
			const child = Bun.spawn(
				['bash', '-c', await step('deploy.yml', 'plan', 'Decide what this run releases')],
				{
					cwd: cwd ?? root,
					env: {
						...withoutGit(),
						...gitEnv,
						PATH: `${bin}:${process.env.PATH ?? ''}`,
						GITHUB_OUTPUT: join(root, 'output'),
						GITHUB_REPOSITORY: 'owner/product',
						GITHUB_SHA: head,
						GITHUB_EVENT_NAME: 'workflow_run',
						GH_TOKEN: 'synthetic-fixture-token',
						DEPLOY_ENABLED: 'true',
						DEPLOY_HOST: 'host.invalid',
						DEPLOY_PATH: '/opt/product',
						DEPLOY_KNOWN_HOSTS: 'ssh-ed25519 AAAAfixture',
						REQUESTED: '',
						CI_CONCLUSION: 'success',
						CI_EVENT: 'push',
						CI_REPOSITORY: 'owner/product',
						CI_SHA: head,
						MAIN_TIP: head,
						...env,
					},
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			const outputs = Object.fromEntries(
				(await readFile(join(root, 'output'), 'utf8'))
					.split('\n')
					.filter(Boolean)
					.map((line) => line.split('=', 2) as [string, string]),
			);
			const gh = Bun.file(join(root, 'gh-calls'));
			const ghCalls = (await gh.exists()) ? (await gh.text()).trim().split('\n') : [];
			return { code, stdout, stderr, outputs, ghCalls };
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const nothing = { build: 'false', deploy: 'false', sha: '', tag: '' };

	it('releases nothing, in green, until DEPLOY_ENABLED is true', async () => {
		for (const enabled of ['', 'false', 'TRUE']) {
			const result = await plan({ DEPLOY_ENABLED: enabled });
			expect(result.code).toBe(0);
			expect(result.outputs).toEqual(nothing);
			expect(result.stdout).toContain('::notice title=Deployment is switched off::');
			expect(result.stdout).toContain('DEPLOY_ENABLED=true');
		}
		// GitHub's expressions compare without case, the plan with it: the notice says why `TRUE` is off.
		expect((await plan({ DEPLOY_ENABLED: 'TRUE' })).stdout).toContain(
			"It is set to 'TRUE': only a lowercase true switches it on.",
		);
		expect((await plan({ DEPLOY_ENABLED: 'false' })).stdout).not.toContain('lowercase');
		// A `v*` tag on a repository that has not switched deployment on builds nothing either.
		const tagged = await plan({ DEPLOY_ENABLED: '', GITHUB_EVENT_NAME: 'push' });
		expect(tagged.code).toBe(0);
		expect(tagged.outputs).toEqual(nothing);
	});

	it('refuses a run by hand while deployment is switched off', async () => {
		const result = await plan({ DEPLOY_ENABLED: '', GITHUB_EVENT_NAME: 'workflow_dispatch' });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('::error title=Deployment is switched off::');
		expect(result.ghCalls).toEqual([]);
	});

	it('builds and deploys the exact commit of a passing CI run of a push to main', async () => {
		const result = await plan({});
		expect(result.code).toBe(0);
		expect(result.outputs).toEqual({
			build: 'true',
			deploy: 'true',
			sha: head,
			tag: 'sha-aaaaaaa',
		});
		// CI's own verdict is the gate here; the one lookup is where main is now.
		expect(result.ghCalls).toEqual(['api repos/owner/product/commits/main --jq .sha']);
	});

	it.each([
		['a failed CI run', { CI_CONCLUSION: 'failure' }],
		['a cancelled CI run', { CI_CONCLUSION: 'cancelled' }],
		["a pull request's CI run, even from a fork branch called main", { CI_EVENT: 'pull_request' }],
		['a CI run of another repository', { CI_REPOSITORY: 'someone/else' }],
		['a commit main has moved past (a re-run of an old CI run)', { CI_SHA: older }],
		// A re-run replays the event, GITHUB_SHA included, so only the API knows main moved on.
		['a re-run of an old Deploy run', { CI_SHA: older, GITHUB_SHA: older }],
	])('releases nothing for %s', async (_, env) => {
		const result = await plan(env);
		expect(result.code).toBe(0);
		expect(result.outputs).toEqual(nothing);
		expect(result.stdout).toContain('::notice');
	});

	it('says how to release a main whose newest push CI skipped', async () => {
		const result = await plan({ CI_SHA: older });
		expect(result.stdout).toContain(
			`::notice title=Superseded::main has moved on from bbbbbbb to aaaaaaa`,
		);
		expect(result.stdout).toContain('push again to release main');
	});

	it('releases nothing, in red, when main cannot be read', async () => {
		for (const tip of ['', 'null', 'not-a-commit']) {
			const result = await plan({ MAIN_TIP: tip });
			expect(result.code).toBe(1);
			expect(result.stdout).toContain('::error title=Cannot read main::');
			expect(result.outputs).toEqual({});
		}
	});

	it('only builds images when DEPLOY_HOST is unset', async () => {
		const result = await plan({ DEPLOY_HOST: '' });
		expect(result.code).toBe(0);
		expect(result.outputs).toEqual({
			build: 'true',
			deploy: 'false',
			sha: head,
			tag: 'sha-aaaaaaa',
		});
		expect(result.stdout).toContain('::notice title=Images only::');
	});

	it('refuses a deploy without DEPLOY_PATH or DEPLOY_KNOWN_HOSTS before anything is built', async () => {
		for (const [unset, title] of [
			['DEPLOY_PATH', 'No checkout path'],
			['DEPLOY_KNOWN_HOSTS', 'No host key'],
		] as const) {
			for (const event of ['workflow_run', 'workflow_dispatch']) {
				const result = await plan({ [unset]: '', GITHUB_EVENT_NAME: event });
				expect(result.code, `${unset} ${event}`).toBe(1);
				expect(result.stdout).toContain(`::error title=${title}::`);
				expect(result.outputs).toEqual({});
			}
			// Neither is needed by a run that deploys nothing.
			for (const env of [{ DEPLOY_HOST: '' }, { GITHUB_EVENT_NAME: 'push' }]) {
				const result = await plan({ [unset]: '', ...env });
				expect(result.code, unset).toBe(0);
				expect(result.outputs.deploy).toBe('false');
			}
		}
	});

	it('builds a v* tag without deploying it', async () => {
		const result = await plan({ GITHUB_EVENT_NAME: 'push' });
		expect(result.code).toBe(0);
		expect(result.outputs).toEqual({
			build: 'true',
			deploy: 'false',
			sha: head,
			tag: 'sha-aaaaaaa',
		});
	});

	it('deploys a run by hand only when CI passed for a push of that commit to main', async () => {
		const green = await plan({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
		expect(green.code).toBe(0);
		expect(green.outputs).toEqual({ build: 'true', deploy: 'true', sha: head, tag: 'sha-aaaaaaa' });
		expect(green.ghCalls).toEqual([
			`api --method GET repos/owner/product/actions/workflows/ci.yml/runs -f head_sha=${head} -f event=push -f branch=main -f status=success -f per_page=1 --jq .total_count`,
		]);
		for (const answer of ['0', '', 'null']) {
			const red = await plan({ GITHUB_EVENT_NAME: 'workflow_dispatch' }, answer);
			expect(red.code).toBe(1);
			expect(red.stdout).toContain('::error title=CI has not passed for this commit::');
			expect(red.outputs).toEqual({});
		}
	});

	it(
		'resolves a requested tag to its full commit before asking CI about it',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'starterdough-release-plan-repo-'));
			try {
				const origin = join(root, 'origin.git');
				const work = join(root, 'work');
				await git(root, 'init', '--quiet', '--bare', origin);
				await git(root, 'clone', '--quiet', origin, work);
				const first = await commit(work, { 'release.txt': '1\n' }, 'first');
				await git(work, 'tag', 'v1.2.0');
				const second = await commit(work, { 'release.txt': '2\n' }, 'second');
				await git(work, 'push', '--quiet', '--tags', 'origin', 'HEAD:refs/heads/main');
				const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: second };

				const bySha = await plan({ ...env, REQUESTED: `sha-${first.slice(0, 7)}` }, '1', work);
				expect(bySha.code).toBe(0);
				expect(bySha.outputs).toEqual({
					build: 'false',
					deploy: 'true',
					sha: first,
					tag: `sha-${first.slice(0, 7)}`,
				});
				expect(bySha.ghCalls[0]).toContain(`head_sha=${first}`);

				const byVersion = await plan({ ...env, REQUESTED: '1.2.0' }, '1', work);
				expect(byVersion.code).toBe(0);
				expect(byVersion.outputs).toEqual({
					build: 'false',
					deploy: 'true',
					sha: first,
					tag: '1.2.0',
				});

				const unknown = await plan({ ...env, REQUESTED: 'sha-0000000' }, '1', work);
				expect(unknown.code).toBe(1);
				expect(unknown.ghCalls).toEqual([]);

				const noHost = await plan({ ...env, REQUESTED: '1.2.0', DEPLOY_HOST: '' }, '1', work);
				expect(noHost.code).toBe(1);
				expect(noHost.stdout).toContain('::error title=No server to deploy to::');
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		GIT_TIMEOUT,
	);

	it.each(['-x', 'a b', 'sha-xyz', 'sha-', 'tag;id'])(
		'refuses the tag input %p',
		async (requested) => {
			const result = await plan({ GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED: requested });
			expect(result.code).toBe(1);
			expect(result.ghCalls).toEqual([]);
		},
	);
});

describe('the SSH target every server workflow uses', () => {
	const script = join(repository, '.github/scripts/ssh-target.sh');
	const base = {
		DEPLOY_ENABLED: 'true',
		DEPLOY_HOST: '203.0.113.7',
		DEPLOY_USER: 'deploy',
		DEPLOY_PATH: '/opt/lumen',
		DEPLOY_SSH_KEY: 'synthetic-fixture-key',
		DEPLOY_KNOWN_HOSTS: 'ssh-ed25519 AAAAone',
	};

	async function target(env: Record<string, string>, args: string[] = []) {
		const home = await mkdtemp(join(tmpdir(), 'starterdough-ssh-target-'));
		try {
			const child = Bun.spawn(['bash', script, ...args], {
				cwd: home,
				env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			const read = async (name: string) => {
				const file = Bun.file(join(home, '.ssh', name));
				return (await file.exists()) ? file.text() : null;
			};
			return {
				code,
				stdout,
				knownHosts: await read('known_hosts_deploy'),
				config: await read('config'),
			};
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	it('pins either key form under one alias, and only that file, with strict checking', async () => {
		const result = await target({
			...base,
			DEPLOY_KNOWN_HOSTS:
				'ssh-ed25519 AAAAone\n# comment\n\nlumen.example.com ssh-ed25519 AAAAtwo key two\n',
		});
		expect(result.code, result.stdout).toBe(0);
		expect(result.knownHosts).toBe(
			'deploy-target ssh-ed25519 AAAAone\ndeploy-target ssh-ed25519 AAAAtwo\n',
		);
		for (const line of [
			'Host target',
			'  HostName 203.0.113.7',
			'  User deploy',
			'  HostKeyAlias deploy-target',
			'  UserKnownHostsFile ~/.ssh/known_hosts_deploy',
			'  StrictHostKeyChecking yes',
			'  BatchMode yes',
		]) {
			expect(result.config?.split('\n')).toContain(line);
		}
		expect(result.config).not.toContain('accept-new');
	});

	it('reads the ssh-keyscan line of a host whose name starts like a key type', async () => {
		const result = await target({
			...base,
			DEPLOY_KNOWN_HOSTS: [
				'ssh-prod.example.com ssh-ed25519 AAAAone',
				'sk-prod ssh-ed25519 AAAAtwo',
				'ecdsa-gw.example.com ecdsa-sha2-nistp256 AAAAthree=',
			].join('\n'),
		});
		expect(result.code, result.stdout).toBe(0);
		expect(result.knownHosts).toBe(
			[
				'deploy-target ssh-ed25519 AAAAone',
				'deploy-target ssh-ed25519 AAAAtwo',
				'deploy-target ecdsa-sha2-nistp256 AAAAthree=',
				'',
			].join('\n'),
		);
	});

	it('strips the carriage returns of a value pasted from Windows', async () => {
		const result = await target({
			...base,
			DEPLOY_KNOWN_HOSTS: '203.0.113.7 ssh-ed25519 AAAAone\r\n',
		});
		expect(result.code, result.stdout).toBe(0);
		expect(result.knownHosts).toBe('deploy-target ssh-ed25519 AAAAone\n');
	});

	it('refuses a missing or unreadable host key, and a path it would quote unsafely', async () => {
		for (const [env, title] of [
			[{ DEPLOY_KNOWN_HOSTS: '' }, 'No host key'],
			[{ DEPLOY_KNOWN_HOSTS: 'not a key' }, 'Unreadable DEPLOY_KNOWN_HOSTS'],
			[{ DEPLOY_KNOWN_HOSTS: '# only a comment' }, 'Unreadable DEPLOY_KNOWN_HOSTS'],
			// A paste cut short: the key type with no key would pin nothing that could ever match.
			[{ DEPLOY_KNOWN_HOSTS: 'ssh-ed25519' }, 'Unreadable DEPLOY_KNOWN_HOSTS'],
			[{ DEPLOY_KNOWN_HOSTS: '203.0.113.7 ssh-ed25519\n' }, 'Unreadable DEPLOY_KNOWN_HOSTS'],
			// Not a key whose type is the host name and whose key is the key's type.
			[{ DEPLOY_KNOWN_HOSTS: 'ssh-prod.example.com ssh-ed25519' }, 'Unreadable DEPLOY_KNOWN_HOSTS'],
			[{ DEPLOY_PATH: '' }, 'No checkout path'],
			[{ DEPLOY_PATH: "/opt/it's" }, 'No checkout path'],
			[{ DEMO_PATH: '/opt/demo; rm -rf ~' }, 'Bad DEMO_PATH'],
			[{ DEPLOY_HOST: '-oProxyCommand=x' }, 'No server'],
		] as const) {
			const result = await target({ ...base, ...env });
			expect(result.code, title).not.toBe(0);
			expect(result.stdout, title).toContain(`::error title=${title}::`);
			expect(result.config, title).toBeNull();
		}
	});

	it('lets only recovery through while deploys are switched off', async () => {
		const off = { ...base, DEPLOY_ENABLED: '' };
		const refused = await target(off);
		expect(refused.code).not.toBe(0);
		expect(refused.stdout).toContain('::error title=Deployment is switched off::');
		expect((await target(off, ['--recovery'])).code).toBe(0);
	});

	it('runs first in every job that reaches the server, and nothing trusts a key on first use', async () => {
		const files = (
			await Array.fromAsync(new Bun.Glob('*.yml').scan(join(repository, '.github/workflows')))
		).sort();
		const reaching: string[] = [];
		for (const file of files) {
			const text = await Bun.file(join(repository, '.github/workflows', file)).text();
			expect(text, file).not.toMatch(/StrictHostKeyChecking[ =]*(accept-new|no)\b/);
			const workflow: unknown = Bun.YAML.parse(text);
			if (!record(workflow) || !record(workflow.jobs)) continue;
			for (const [name, job] of Object.entries(workflow.jobs)) {
				if (!record(job) || !Array.isArray(job.steps)) continue;
				const runs = job.steps.map((value) =>
					record(value) && typeof value.run === 'string' ? value.run : '',
				);
				const first = runs.findIndex((run) => /ssh target|target:|check-clock\.sh/.test(run));
				if (first === -1) continue;
				reaching.push(`${file} ${name}`);
				const pinned = runs.findIndex((run) => run.includes('.github/scripts/ssh-target.sh'));
				expect(pinned, `${file} ${name}`).toBeGreaterThan(-1);
				expect(pinned, `${file} ${name}`).toBeLessThan(first);
			}
		}
		expect(reaching).toEqual(
			expect.arrayContaining(['deploy.yml deploy', 'recover-deployment.yml recovery']),
		);
	});
});

describe('the server clock check', () => {
	async function clock(answer: string, args: string[] = []) {
		const root = await mkdtemp(join(tmpdir(), 'starterdough-clock-'));
		try {
			// `ssh target 'date +%s'` answers with the runner's time shifted, or with ANSWER as given.
			await writeFile(join(root, 'ssh'), `#!/bin/sh\n${answer}\n`, { mode: 0o700 });
			const child = Bun.spawn(
				['bash', join(repository, '.github/scripts/check-clock.sh'), ...args],
				{
					env: { PATH: `${root}:${process.env.PATH ?? ''}` },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			return { code, stdout };
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it('passes within 30 seconds and fails beyond, or only warns when asked to', async () => {
		expect((await clock('echo $(( $(date +%s) + 5 ))')).code).toBe(0);
		const fast = await clock('echo $(( $(date +%s) + 120 ))');
		expect(fast.code).toBe(1);
		expect(fast.stdout).toMatch(/::error title=Server clock::The server clock is 1[12]\d s off/);
		const slow = await clock('echo $(( $(date +%s) - 120 ))');
		expect(slow.code).toBe(1);
		const warned = await clock('echo $(( $(date +%s) + 120 ))', ['warn']);
		expect(warned.code).toBe(0);
		expect(warned.stdout).toContain('::warning title=Server clock::');
	});

	it('fails when the server does not answer with a time', async () => {
		for (const answer of ['echo', 'echo soon', 'exit 255']) {
			expect((await clock(answer, ['warn'])).code, answer).not.toBe(0);
		}
	});

	it('runs in the deploy job after the SSH target and before anything reaches the checkout', async () => {
		const workflow = Bun.YAML.parse(
			await Bun.file(join(repository, '.github/workflows/deploy.yml')).text(),
		) as { jobs: { deploy: { steps: { name?: string }[] } } };
		const names = workflow.jobs.deploy.steps.map((value) => value.name);
		const at = (name: string) => names.indexOf(name);
		expect(at("Server clock against the runner's")).toBe(
			at('SSH to the server, host key pinned') + 1,
		);
		expect(at("Server clock against the runner's")).toBeLessThan(
			at('Deliver the release commit to the server'),
		);
	});
});

describe('the smoke test after a deploy', () => {
	const name = 'Smoke-test the public URLs';

	async function smoke(env: Record<string, string>, fail = '') {
		const root = await mkdtemp(join(tmpdir(), 'starterdough-smoke-'));
		try {
			const calls = join(root, 'calls');
			await writeFile(
				join(root, 'curl'),
				`#!/bin/sh\nfor last do :; done\necho "$last" >> "${calls}"\n[ "$last" != '${fail}' ]\n`,
				{ mode: 0o700 },
			);
			const child = Bun.spawn(['bash', '-c', await step('deploy.yml', 'deploy', name)], {
				env: { PATH: `${root}:${process.env.PATH ?? ''}`, ...env },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			const file = Bun.file(calls);
			return {
				code,
				stdout,
				calls: (await file.exists()) ? (await file.text()).trim().split('\n') : [],
			};
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it('fetches /readyz and the app from outside, and fails when either does', async () => {
		const urls = { API_URL: 'https://api.example.test/', WEB_URL: 'https://app.example.test' };
		const ok = await smoke(urls);
		expect(ok.code).toBe(0);
		expect(ok.calls).toEqual(['https://api.example.test/readyz', 'https://app.example.test']);
		expect((await smoke(urls, 'https://api.example.test/readyz')).code).not.toBe(0);
		expect((await smoke(urls, 'https://app.example.test')).code).not.toBe(0);
		const unset = await smoke({ API_URL: '', WEB_URL: urls.WEB_URL });
		expect(unset.code).toBe(1);
		expect(unset.stdout).toContain('::error title=Nothing to smoke-test::');
		expect(unset.calls).toEqual([]);
	});

	it('runs last, can be switched off, and the job has a timeout for hangs only', async () => {
		const workflow = Bun.YAML.parse(
			await Bun.file(join(repository, '.github/workflows/deploy.yml')).text(),
		) as {
			jobs: { deploy: { 'timeout-minutes'?: number; steps: { name?: string; if?: string }[] } };
		};
		const { deploy } = workflow.jobs;
		expect(deploy.steps.at(-1)).toMatchObject({ name, if: "vars.SMOKE_TEST != 'off'" });
		expect(deploy['timeout-minutes']).toBe(180);
	});
});

describe('the deploy workflow releases only through the plan', () => {
	it('follows CI instead of pushes to main, and gates every job on the plan', async () => {
		const parse = async (file: string) =>
			Bun.YAML.parse(await Bun.file(join(repository, '.github/workflows', file)).text()) as {
				name?: string;
				on: Record<string, Record<string, unknown> | null>;
				jobs: Record<string, { needs?: string | string[]; if?: string }>;
			};
		const [deploy, ci] = await Promise.all([parse('deploy.yml'), parse('ci.yml')]);
		expect(deploy.on.push).toEqual({ tags: ['v*'] });
		expect(deploy.on.workflow_run).toEqual({
			workflows: [ci.name],
			types: ['completed'],
			branches: ['main'],
		});
		expect(Object.keys(deploy.on).sort()).toEqual(['push', 'workflow_dispatch', 'workflow_run']);
		const { plan, ...gated } = deploy.jobs;
		expect(plan?.if).toBeUndefined();
		for (const [name, job] of Object.entries(gated)) {
			expect([job.needs].flat()).toContain('plan');
			expect(job.if, name).toContain('needs.plan.outputs.');
		}
		expect(deploy.jobs.deploy?.if).toContain("needs.plan.outputs.deploy == 'true'");
	});
});

describe('release delivery without repository credentials on the server', () => {
	// The recovery contract the Deploy step checks for in the release commit, as stubs.
	const contract = {
		'infra/scripts/operation-lock.sh': 'acquire_operation_lock() { return 0; }\n',
		'infra/scripts/deployment-recovery.sh': 'deployment_refuse_pending() { return 0; }\n',
		'infra/scripts/deployment-recovery.py': '',
		'infra/scripts/recover-deployment.sh': '',
	};

	async function setup(
		run: (paths: { root: string; bin: string; runner: string }) => Promise<void>,
	) {
		const root = await mkdtemp(join(tmpdir(), 'starterdough-release-delivery-'));
		try {
			const bin = join(root, 'bin');
			const runner = join(root, 'runner');
			await Promise.all([mkdir(bin), mkdir(join(root, 'state')), mkdir(join(root, 'runner-temp'))]);
			await Promise.all([
				writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
				// Every checkout here runs this product's Compose project, and `demo` the demo's.
				writeFile(
					join(bin, 'docker'),
					`#!/bin/sh\n[ "$*" = "compose config" ] && { ${projectByCheckout}; }\nexit 0\n`,
					{ mode: 0o700 },
				),
				// `ssh target <command>` runs <command> here, as sshd would on the server; Git's own
				// `git-receive-pack '<path>'` included.
				writeFile(join(bin, 'ssh'), '#!/bin/bash\nfor last do :; done\nexec bash -c "$last"\n', {
					mode: 0o700,
				}),
			]);
			await git(root, 'init', '--quiet', '--initial-branch=main', runner);
			await run({ root, bin, runner });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	/** A server checkout cloned before `release` existed, whose origin can no longer be reached. */
	async function server(root: string, runner: string, name: string) {
		const path = join(root, name);
		await git(root, 'clone', '--quiet', runner, path);
		await git(path, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
		return path;
	}

	function run(
		root: string,
		bin: string,
		cwd: string,
		script: string,
		env: Record<string, string>,
	) {
		return Bun.spawn(['bash', '-c', script], {
			cwd,
			env: {
				...withoutGit(),
				...gitEnv,
				// The release reaches each checkout as `git push target:<path>`, over bin/ssh.
				GIT_ALLOW_PROTOCOL: 'file:ssh',
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				STARTERDOUGH_STATE_DIR: join(root, 'state'),
				RUNNER_TEMP: join(root, 'runner-temp'),
				DEPLOY_HOST: 'host.invalid',
				DEPLOY_USER: 'deploy',
				EXPECTED_DEMO_PROJECT: 'starterdough-demo',
				...env,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
	}

	async function result(child: ReturnType<typeof run>) {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	}

	it(
		'pushes the release into both checkouts, then deploys it without fetching',
		async () => {
			await setup(async ({ root, bin, runner }) => {
				const calls = join(root, 'calls');
				const previous = await commit(runner, { ...contract, 'release.txt': '1\n' }, 'previous');
				const production = await server(root, runner, 'production');
				const demo = await server(root, runner, 'demo');
				const release = await commit(
					runner,
					{
						'release.txt': '2\n',
						'infra/scripts/deploy.sh':
							'# sources deployment-recovery.sh\nset -euo pipefail\n[ -z "$GIT_REF" ]\necho production-deploy >> "$CALLS"\n',
						'infra/demo/update.sh':
							'# sources deployment-recovery.sh\necho demo-update >> "$CALLS"\n',
						'infra/demo/reset.sh': '# sources deployment-recovery.sh\n',
					},
					'release',
				);
				const env = {
					DEPLOY_PATH: production,
					DEMO_PATH: demo,
					EXPECTED_PROJECT: 'starterdough',
					GIT_REF: release,
					IMAGE_TAG: `sha-${release.slice(0, 7)}`,
					CALLS: calls,
				};

				const delivered = await result(
					run(
						root,
						bin,
						runner,
						await step('deploy.yml', 'deploy', 'Deliver the release commit to the server'),
						env,
					),
				);
				expect(delivered.code).toBe(0);
				for (const checkout of [production, demo]) {
					expect(await git(checkout, 'rev-parse', 'refs/starterdough/release')).toBe(release);
					// Delivery alone changes nothing the running stack depends on.
					expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(previous);
					expect(await git(checkout, 'status', '--porcelain')).toBe('');
				}

				// Real merge-base: both checkouts share the delivered commit's history.
				const guarded = await result(
					run(
						root,
						bin,
						runner,
						await step('deploy.yml', 'deploy', "Refuse a checkout that is not this product's"),
						env,
					),
				);
				expect(guarded.code, guarded.stderr).toBe(0);

				const deployed = await result(
					run(root, bin, runner, await step('deploy.yml', 'deploy', 'Deploy'), env),
				);
				expect(deployed.code).toBe(0);
				expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([
					'demo-update',
					'production-deploy',
				]);
				for (const checkout of [production, demo]) {
					expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(release);
				}

				// A rollback is the same push with an older commit: the ref moves backwards.
				const rollback = await result(
					run(
						root,
						bin,
						runner,
						await step('deploy.yml', 'deploy', 'Deliver the release commit to the server'),
						{
							...env,
							GIT_REF: previous,
						},
					),
				);
				expect(rollback.code).toBe(0);
				expect(await git(production, 'rev-parse', 'refs/starterdough/release')).toBe(previous);
			});
		},
		GIT_TIMEOUT,
	);

	it(
		'refuses, after delivery, a DEPLOY_PATH or DEMO_PATH holding another repository',
		async () => {
			await setup(async ({ root, bin, runner }) => {
				await commit(runner, { 'release.txt': '1\n' }, 'previous');
				const production = await server(root, runner, 'production');
				const release = await commit(runner, { 'release.txt': '2\n' }, 'release');
				// Another product's checkout: a repository of its own, with its own history.
				const stranger = join(root, 'stranger');
				await git(root, 'init', '--quiet', '--initial-branch=main', stranger);
				await commit(stranger, { 'other.txt': 'theirs\n' }, 'theirs');
				const guard = await step(
					'deploy.yml',
					'deploy',
					"Refuse a checkout that is not this product's",
				);
				for (const [deployPath, demoPath, message] of [
					[stranger, '', 'DEPLOY_PATH names another checkout'],
					[production, stranger, 'DEMO_PATH names another checkout'],
				] as const) {
					const env = {
						DEPLOY_PATH: deployPath,
						DEMO_PATH: demoPath,
						EXPECTED_PROJECT: 'starterdough',
						GIT_REF: release,
					};
					const delivered = await result(
						run(
							root,
							bin,
							runner,
							await step('deploy.yml', 'deploy', 'Deliver the release commit to the server'),
							env,
						),
					);
					expect(delivered.code, message).toBe(0);
					const refused = await result(run(root, bin, runner, guard, env));
					expect(refused.code, message).not.toBe(0);
					expect(refused.stderr, message).toContain(message);
				}
			});
		},
		GIT_TIMEOUT,
	);

	it(
		'skips an unset DEMO_PATH and fails on a server without the checkout',
		async () => {
			await setup(async ({ root, bin, runner }) => {
				const release = await commit(runner, { 'release.txt': '1\n' }, 'release');
				const production = await server(root, runner, 'production');
				const script = await step(
					'deploy.yml',
					'deploy',
					'Deliver the release commit to the server',
				);
				const ok = await result(
					run(root, bin, runner, script, {
						DEPLOY_PATH: production,
						DEMO_PATH: '',
						GIT_REF: release,
					}),
				);
				expect(ok.code).toBe(0);
				expect(await git(production, 'rev-parse', 'refs/starterdough/release')).toBe(release);
				const missing = await result(
					run(root, bin, runner, script, {
						DEPLOY_PATH: join(root, 'not-provisioned'),
						DEMO_PATH: '',
						GIT_REF: release,
					}),
				);
				expect(missing.code).not.toBe(0);
			});
		},
		GIT_TIMEOUT,
	);

	it(
		'rolls back by hand on the server to a delivered commit without fetching',
		async () => {
			await setup(async ({ root, bin, runner }) => {
				const deploySh = await readFile(join(repository, 'infra/scripts/deploy.sh'), 'utf8');
				await commit(
					runner,
					{ ...contract, 'infra/scripts/deploy.sh': deploySh, 'release.txt': '1\n' },
					'one',
				);
				const production = await server(root, runner, 'production');
				const delivered = await commit(runner, { 'release.txt': '2\n' }, 'two');
				const unseen = await commit(runner, { 'release.txt': '3\n' }, 'three');
				await git(runner, 'push', '--quiet', production, `${delivered}:refs/starterdough/release`);

				// deploy.sh checks the commit out, then stops at the missing .env: far enough to show
				// whether it needed origin, which this checkout can no longer reach.
				const rolledBack = await result(
					run(root, bin, production, 'bash infra/scripts/deploy.sh', {
						GIT_REF: delivered,
						IMAGE_TAG: 'sha-x',
					}),
				);
				expect(rolledBack.code).toBe(1);
				expect(rolledBack.stderr).toContain('no .env');
				expect(await git(production, 'rev-parse', 'HEAD')).toBe(delivered);

				// A commit the box has never seen still comes from origin, which fails here.
				const fetched = await result(
					run(root, bin, production, 'bash infra/scripts/deploy.sh', {
						GIT_REF: unseen,
						IMAGE_TAG: 'sha-y',
					}),
				);
				expect(fetched.code).not.toBe(0);
				expect(fetched.stderr).not.toContain('no .env');
				expect(await git(production, 'rev-parse', 'HEAD')).toBe(delivered);
			});
		},
		GIT_TIMEOUT,
	);

	it(
		'moves the demo by hand to a delivered commit without fetching',
		async () => {
			await setup(async ({ root, bin, runner }) => {
				const updateSh = await readFile(join(repository, 'infra/demo/update.sh'), 'utf8');
				await commit(
					runner,
					{ ...contract, 'infra/demo/update.sh': updateSh, 'release.txt': '1\n' },
					'one',
				);
				const demo = await server(root, runner, 'demo');
				const delivered = await commit(runner, { 'release.txt': '2\n' }, 'two');
				const unseen = await commit(runner, { 'release.txt': '3\n' }, 'three');
				await git(runner, 'push', '--quiet', demo, `${delivered}:refs/starterdough/release`);
				// The demo's identity, as update.sh asks Compose for it before it moves anything.
				await writeFile(
					join(bin, 'docker'),
					'#!/bin/sh\ncase "$*" in\n"compose config --services") echo demo-api ;;\n"compose config") echo "name: starterdough-demo" ;;\nesac\n',
					{ mode: 0o700 },
				);
				// No IMAGE_TAG or IMAGE_REGISTRY row: update.sh checks the commit out, then stops at the
				// missing registry, far enough to show whether it needed origin.
				await writeFile(join(demo, '.env'), 'COMPOSE_FILE=infra/demo/compose.yml\n');

				const moved = await result(
					run(root, bin, demo, 'bash infra/demo/update.sh', {
						GIT_REF: delivered,
						IMAGE_TAG: 'sha-x',
						IMAGE_REGISTRY: '',
					}),
				);
				expect(moved.stderr).toContain('no IMAGE_REGISTRY');
				expect(moved.code).toBe(1);
				expect(await git(demo, 'rev-parse', 'HEAD')).toBe(delivered);

				// A commit the box has never seen still comes from origin, which fails here.
				const fetched = await result(
					run(root, bin, demo, 'bash infra/demo/update.sh', {
						GIT_REF: unseen,
						IMAGE_TAG: 'sha-y',
						IMAGE_REGISTRY: '',
					}),
				);
				expect(fetched.code).not.toBe(0);
				expect(fetched.stderr).not.toContain('no IMAGE_REGISTRY');
				expect(await git(demo, 'rev-parse', 'HEAD')).toBe(delivered);
			});
		},
		GIT_TIMEOUT,
	);
});
