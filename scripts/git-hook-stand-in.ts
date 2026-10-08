/**
 * For test files that run real git. Git exports the repository a hook runs in to the hook
 * (`GIT_DIR`, plus `GIT_INDEX_FILE` and `GIT_WORK_TREE` from a linked worktree), and lefthook's
 * pre-push `bun run verify` hands those on to every test. A git command that inherits them works on
 * that repository instead of its fixture: the case fails, or commits and tags in the repository
 * being pushed. So every git command a test runs gets `withoutGit()` plus its own `GIT_*`, and
 * `standInForGitHook()` proves it, case by case.
 */
import { afterAll, afterEach, beforeAll, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** This process's environment without any `GIT_*` variable. Read it per command, not once. */
export function withoutGit(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_'),
		),
	);
}

const HOOK_KEYS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		env: {
			...withoutGit(),
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_AUTHOR_NAME: 'Hook stand-in',
			GIT_AUTHOR_EMAIL: 'hook@example.invalid',
			GIT_COMMITTER_NAME: 'Hook stand-in',
			GIT_COMMITTER_EMAIL: 'hook@example.invalid',
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

/** A spawn's options with `env` defaulting to process.env as it is now. */
function currentEnv<T extends unknown[]>(args: T): T {
	const [first, options, ...rest] = args;
	return (
		Array.isArray(first)
			? [first, { env: process.env, ...(options as object | undefined) }, ...rest]
			: [{ env: process.env, ...(first as object) }, options, ...rest]
	) as T;
}

/**
 * Call once, at the top of a test file: every case in it then runs as if under that hook, with a
 * scratch repository standing in for the one being pushed. Its variables go into process.env. Bun
 * hands a spawn without `env` the environment this process started with, which a real hook fills
 * in and this cannot change, so for the file's duration such a spawn gets process.env instead.
 * (`Bun.$` and node:child_process are not covered.) After each case the stand-in must look exactly
 * as it did; after the file, the variables, a real hook's included, and Bun's spawns are put back.
 */
export function standInForGitHook(): void {
	// Taken when the file's cases start, not when it loads, so files that share a process each put
	// back what they found.
	let saved: Record<string, string | undefined> = {};
	let { spawn, spawnSync } = Bun;
	let host = '';
	let before = '';
	const state = () =>
		[
			git(host, 'for-each-ref'),
			git(host, 'rev-parse', 'HEAD'),
			git(host, 'status', '--porcelain', '--untracked-files=all'),
			git(host, 'config', '--local', '--list'),
		].join('\n');

	beforeAll(() => {
		saved = Object.fromEntries(HOOK_KEYS.map((key) => [key, process.env[key]]));
		({ spawn, spawnSync } = Bun);
		host = mkdtempSync(join(tmpdir(), 'starterdough-hook-host-'));
		git(host, 'init', '--quiet', '--initial-branch=main');
		git(host, 'commit', '--quiet', '--allow-empty', '-m', 'The repository being pushed');
		before = state();
		Object.assign(process.env, {
			GIT_DIR: join(host, '.git'),
			GIT_INDEX_FILE: join(host, '.git', 'index'),
			GIT_WORK_TREE: host,
		});
		Object.assign(Bun, {
			spawn: (...args: Parameters<typeof spawn>) => spawn(...currentEnv(args)),
			spawnSync: (...args: Parameters<typeof spawnSync>) => spawnSync(...currentEnv(args)),
		});
	});

	afterEach(() => {
		const expected = before;
		// Fail the case that wrote to the stand-in, not every case after it as well.
		before = state();
		expect(before).toBe(expected);
	});

	afterAll(() => {
		Object.assign(Bun, { spawn, spawnSync });
		for (const key of HOOK_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(host, { recursive: true, force: true });
	});
}
