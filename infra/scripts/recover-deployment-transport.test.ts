import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { standInForGitHook, withoutGit } from '../../scripts/git-hook-stand-in';

const repository = resolve(import.meta.dir, '../..');

// Several cases below drive real git; under lefthook's pre-push hook, inherited GIT_* variables
// would point it at the repository being pushed. Every spawn here starts from `withoutGit()`.
standInForGitHook();

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
