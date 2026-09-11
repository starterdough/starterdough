import { rename, rm } from 'node:fs/promises';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	/** True when the process was killed rather than exiting on its own — a `timeoutMs` that fired. */
	killed: boolean;
	/** The ceiling that was in force, so the error message can name it. */
	timeoutMs: number | undefined;
}

export class CommandError extends Error {
	override name = 'CommandError';
	constructor(
		readonly command: string,
		readonly result: RunResult,
	) {
		const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
		super(
			result.killed && result.timeoutMs !== undefined
				? `${command} was killed after its ${result.timeoutMs} ms timeout (${result.durationMs} ms elapsed): ${detail}`
				: `${command} exited with code ${result.code}: ${detail}`,
		);
	}
}

/**
 * Ceilings for the commands that talk to a database or read every file: long enough that a real
 * dump of a real database finishes, short enough that a hung one does not keep the scheduler's
 * overlap guard closed for weeks. `BACKUP_COMMAND_TIMEOUT_MINUTES` moves it.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 6 * 3_600_000;

/** Ceiling for the commands that only read a local file's table of contents. */
export const SHORT_COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
	/**
	 * Kills the process (SIGKILL) after this many milliseconds. Every call passes one: Bun's spawn
	 * has no default, so without it a `pg_dump` waiting on a lock or a stalled S3 endpoint hangs
	 * the run forever and no later tick can start.
	 */
	timeoutMs?: number;
}

/**
 * Runs a command to completion, capturing both streams. Tools like pg_dump write their errors to
 * stderr and exit non-zero, so callers get everything they need to fail loudly.
 */
export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
	const started = performance.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const proc = Bun.spawn(cmd, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...options.env },
		cwd: options.cwd,
		timeout: timeoutMs,
		killSignal: 'SIGKILL',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// A killed process reports `exitCode: null` and the signal that ended it; the resolved code is
	// 128 + signal, which is not something the process itself could have returned.
	const killed = proc.exitCode === null && proc.signalCode !== null;
	return {
		code,
		stdout,
		stderr,
		durationMs: Math.round(performance.now() - started),
		killed,
		timeoutMs,
	};
}

/** `run`, but a non-zero exit becomes a {@link CommandError} carrying the captured stderr. */
export async function runOrThrow(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
	const result = await run(cmd, options);
	if (result.code !== 0) throw new CommandError(cmd[0] ?? '?', result);
	return result;
}

/**
 * Produces the file under a `.part` name and renames it into place only after the producer
 * succeeded, so a crash, a failing pg_dump or a broken download never leaves something that
 * looks like a valid artifact.
 */
export async function writeViaPartFile<T>(
	path: string,
	produce: (partPath: string) => Promise<T>,
): Promise<T> {
	const part = `${path}.part`;
	try {
		const result = await produce(part);
		await rename(part, path);
		return result;
	} catch (error) {
		await rm(part, { force: true });
		throw error;
	}
}

/** `pg_dump (PostgreSQL) 17.6` → `17.6`. */
export function parseVersion(output: string): string {
	return /(\d+(?:\.\d+)*)/.exec(output)?.[1] ?? output.trim();
}
