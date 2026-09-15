import { BackupError, runBackup, runHousekeeping, sendFailureHeartbeat } from './backup';
import { type BackupConfig, ConfigError, configFromEnv, parseDuration } from './config';
import { listBackups } from './list';
import { createLogger, errorMessage, type Logger } from './log';
import { CommandError } from './proc';
import { RestoreError, type RestoreOptions, restore } from './restore';

export type Command =
	| { command: 'backup' }
	/** `undefined`: use `BACKUP_MAX_AGE`. `null`: `--no-max-age`, do not check freshness at all. */
	| { command: 'list'; maxAgeMs?: number | null }
	| { command: 'schedule' }
	| { command: 'help' }
	| ({ command: 'restore' } & Required<
			Pick<
				RestoreOptions,
				| 'name'
				| 'drill'
				| 'yes'
				| 'uploads'
				| 'noSafetyDump'
				| 'forceDatabaseMismatch'
				| 'noManifestCheck'
				| 'noSingleTransaction'
				| 'terminateConnections'
			>
	  > &
			Pick<RestoreOptions, 'database'>);

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

export const USAGE = `Usage: bun src/cli.ts <command> [options]

Commands:
  backup                         dump the database (and the uploads directory with the local
                                 storage driver), copy the set to S3 when configured, verify the
                                 off-box copy, prune, then ping BACKUP_HEARTBEAT_URL
  restore <name|latest> [flags]  restore a dump; <name> is a stamp (20260909T023000Z) or file
      --drill                    restore into a scratch database, report, drop it (safe)
      --database <name>          target database (live) or schema source for a drill
      --yes                      required to restore into the live database (--clean --if-exists)
      --uploads                  also install the uploads archive into STORAGE_DIR (live only;
                                 drills always verify the archive without installing it)
      --no-safety-dump           skip the pre-restore dump a live restore takes by default
      --force-database-mismatch  restore even though the manifest names another database
      --no-manifest-check        restore a set whose manifest is missing (nothing is verified)
      --no-single-transaction    restore statement by statement; a failure leaves it half-restored
      --terminate-connections    disconnect other sessions instead of refusing the restore
  list [--max-age <duration>]    show backup sets on disk and in the bucket; exits 1 when the
                                 newest set is older than --max-age (default BACKUP_MAX_AGE, 36h)
      --no-max-age               list without the freshness check
  schedule                       run backups on BACKUP_SCHEDULE (cron, UTC) until SIGTERM;
                                 BACKUP_CATCHUP=true (the default) runs one at start when the
                                 newest set is older than one schedule interval, and
                                 BACKUP_ON_START=true runs one at start unconditionally

Durations are one number and one unit: 90s, 45m, 36h, 2d.

Exit codes: 0 ok, 1 failure or refused, 2 usage error.`;

const FLAGS = new Set([
	'--drill',
	'--yes',
	'--uploads',
	'--database',
	'--no-safety-dump',
	'--force-database-mismatch',
	'--no-manifest-check',
	'--no-single-transaction',
	'--terminate-connections',
]);

export function parseArgs(argv: string[]): ParseResult {
	const [command, ...rest] = argv;
	switch (command) {
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			return { ok: true, command: { command: 'help' } };
		case 'backup':
		case 'schedule':
			if (rest.length > 0) return { ok: false, error: `${command} takes no arguments` };
			return { ok: true, command: { command } };
		case 'list':
			return parseList(rest);
		case 'restore':
			return parseRestore(rest);
		default:
			return { ok: false, error: `unknown command "${command}"` };
	}
}

/**
 * `maxAgeMs: undefined` in the parsed command means "the configured default"; `null` means the
 * caller turned the check off. The parser has no configuration, so it cannot resolve the default.
 */
function parseList(args: string[]): ParseResult {
	let maxAgeMs: number | null | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const [flag, inlineValue] = arg.startsWith('--') ? splitFlag(arg) : [undefined, undefined];
		if (flag === '--no-max-age') {
			if (inlineValue !== undefined) return { ok: false, error: '--no-max-age takes no value' };
			maxAgeMs = null;
			continue;
		}
		if (flag === '--max-age') {
			const value = inlineValue ?? args[++i];
			if (!value || value.startsWith('--')) {
				return { ok: false, error: '--max-age needs a duration such as 36h' };
			}
			const parsed = parseDuration(value);
			if (parsed === null) {
				return { ok: false, error: `--max-age must be a duration such as 90s, 45m, 36h or 2d` };
			}
			maxAgeMs = parsed;
			continue;
		}
		return { ok: false, error: flag ? `unknown option "${flag}"` : `unexpected argument "${arg}"` };
	}
	return { ok: true, command: { command: 'list', maxAgeMs } };
}

function parseRestore(args: string[]): ParseResult {
	let name: string | undefined;
	let database: string | undefined;
	let drill = false;
	let yes = false;
	let uploads = false;
	let noSafetyDump = false;
	let forceDatabaseMismatch = false;
	let noManifestCheck = false;
	let noSingleTransaction = false;
	let terminateConnections = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const [flag, inlineValue] = arg.startsWith('--') ? splitFlag(arg) : [undefined, undefined];
		if (flag === undefined) {
			if (name !== undefined) return { ok: false, error: `unexpected argument "${arg}"` };
			name = arg;
			continue;
		}
		if (!FLAGS.has(flag)) return { ok: false, error: `unknown option "${flag}"` };
		if (flag === '--database') {
			const value = inlineValue ?? args[++i];
			if (!value || value.startsWith('--')) {
				return { ok: false, error: '--database needs a database name' };
			}
			database = value;
			continue;
		}
		if (inlineValue !== undefined) return { ok: false, error: `${flag} takes no value` };
		if (flag === '--drill') drill = true;
		else if (flag === '--yes') yes = true;
		else if (flag === '--no-safety-dump') noSafetyDump = true;
		else if (flag === '--force-database-mismatch') forceDatabaseMismatch = true;
		else if (flag === '--no-manifest-check') noManifestCheck = true;
		else if (flag === '--no-single-transaction') noSingleTransaction = true;
		else if (flag === '--terminate-connections') terminateConnections = true;
		else uploads = true;
	}
	if (!name) return { ok: false, error: 'restore needs a backup name or "latest"' };
	return {
		ok: true,
		command: {
			command: 'restore',
			name,
			database,
			drill,
			yes,
			uploads,
			noSafetyDump,
			forceDatabaseMismatch,
			noManifestCheck,
			noSingleTransaction,
			terminateConnections,
		},
	};
}

function splitFlag(arg: string): [string, string | undefined] {
	const eq = arg.indexOf('=');
	return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

export async function main(
	argv: string[],
	env = process.env,
	log = createLogger(),
): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		// Through the logger like every other failure, so one output format covers the lot; `help`
		// prints the usage text itself, which is output the caller asked for rather than a log line.
		log.error(`usage: ${parsed.error}`, { hint: 'run "bun src/cli.ts help" for the usage text' });
		return 2;
	}
	const command = parsed.command;
	if (command.command === 'help') {
		console.log(USAGE);
		return 0;
	}

	let config: BackupConfig;
	try {
		config = configFromEnv(env);
	} catch (error) {
		log.error(error instanceof ConfigError ? error.message : errorMessage(error));
		return 1;
	}
	// `backup` logs the warnings itself, once per run, so every night of a months-long scheduler
	// process carries them.
	if (command.command !== 'backup') for (const warning of config.warnings) log.warn(warning);

	try {
		switch (command.command) {
			case 'backup': {
				const summary = await runBackup(config, log);
				log.info('backup complete', { ...summary });
				return 0;
			}
			case 'restore': {
				const { command: _, ...options } = command;
				const result = await restore(config, options, log);
				log[result.ok ? 'info' : 'error'](
					result.ok ? `restore ${result.mode} complete` : `restore ${result.mode}`,
					{ ...result, report: undefined },
				);
				return result.ok ? 0 : 1;
			}
			case 'list': {
				// `--no-max-age` still lists everything; an infinite limit only stops a stale set from
				// becoming an exit code, which is what a human browsing a fresh box wants and what a
				// monitor never does.
				const maxAgeMs =
					command.maxAgeMs === null
						? Number.POSITIVE_INFINITY
						: (command.maxAgeMs ?? config.maxAgeMs);
				const result = await listBackups({ ...config, maxAgeMs }, log);
				return result.fresh ? 0 : 1;
			}
			case 'schedule':
				return schedule(config, log);
		}
	} catch (error) {
		const known =
			error instanceof ConfigError ||
			error instanceof RestoreError ||
			error instanceof BackupError ||
			error instanceof CommandError;
		log.error(`${command.command} failed`, {
			error: errorMessage(error),
			...(known || !(error instanceof Error) ? {} : { stack: error.stack }),
		});
		return 1;
	}
}

const TZ = 'UTC';

/**
 * Keeps the process alive on `Bun.cron` and stops on SIGTERM/SIGINT. A backup that is running
 * when the signal arrives is allowed to finish (Compose waits `stop_grace_period` before killing).
 */
async function schedule(config: BackupConfig, log: Logger): Promise<number> {
	let next: Date | null;
	try {
		next = Bun.cron.parse(config.schedule, Date.now(), { tz: TZ });
	} catch (error) {
		log.error('BACKUP_SCHEDULE is not a valid cron expression', {
			schedule: config.schedule,
			error: errorMessage(error),
		});
		return 1;
	}
	if (!next) {
		log.error('BACKUP_SCHEDULE never matches', { schedule: config.schedule });
		return 1;
	}
	const intervalMs = scheduleIntervalMs(config.schedule, next);
	log.info('scheduler started', {
		schedule: config.schedule,
		tz: TZ,
		nextRun: next.toISOString(),
		intervalMs,
		retentionDays: config.retentionDays,
		dir: config.backupDir,
		bucket: config.s3 ? `${config.s3.bucket}/${config.s3.prefix}` : null,
		uploads: config.uploads.kind === 'directory' ? config.uploads.dir : 'skipped',
		heartbeat: config.heartbeatUrl ? 'configured' : 'none',
		runOnStart: config.runOnStart,
		catchUp: config.catchUp,
	});

	let running: Promise<void> | null = null;
	const runOnce = async (trigger: 'tick' | 'start' | 'catch-up') => {
		if (running) {
			log.warn('backup still running; skipping this tick', { trigger });
			return;
		}
		running = (async () => {
			try {
				const summary = await runBackup(config, log);
				log.info('backup complete', { ...summary, trigger });
			} catch (error) {
				// Caught here so one failed night does not kill the scheduler.
				log.error('backup failed', { error: errorMessage(error), trigger });
				// The monitor hears about it now instead of at the next missed ping.
				await sendFailureHeartbeat(config, log);
			}
			const upcoming = Bun.cron.parse(config.schedule, Date.now(), { tz: TZ });
			log.info('next run', { nextRun: upcoming?.toISOString() ?? null });
		})();
		try {
			await running;
		} finally {
			// In a `finally`: an error thrown outside the inner try (a logger that throws, a rejected
			// `await running`) must not leave the guard latched, or every later tick is skipped with
			// "backup still running" for as long as the process lives.
			running = null;
		}
	};

	const job = Bun.cron(
		config.schedule,
		async () => {
			await runOnce('tick');
		},
		{ tz: TZ },
	);

	const finished = new Promise<number>((resolve) => {
		const stop = (signal: string) => {
			job.stop();
			log.info('scheduler stopping', { signal, waitingForRunningBackup: running !== null });
			(running ?? Promise.resolve()).then(() => resolve(0));
		};
		process.once('SIGTERM', () => stop('SIGTERM'));
		process.once('SIGINT', () => stop('SIGINT'));
	});

	// After the signal handlers are in place, so a shutdown during either still waits for the backup.
	// Retention and the leftovers of an interrupted run are dealt with at start rather than at the
	// first tick: a container that crash-loops or a schedule that never fires would never prune.
	const pruned = await runHousekeeping(config, log);
	log.info('housekeeping at start', { ...pruned });
	if (config.runOnStart) {
		await runOnce('start');
	} else if (config.catchUp && intervalMs !== null) {
		await catchUp(config, intervalMs, log, runOnce);
	}
	return finished;
}

/**
 * Time between two firings of the expression, from the first upcoming one. Null when the schedule
 * fires only once (`Bun.cron.parse` then has no second answer) and there is nothing to catch up to.
 */
function scheduleIntervalMs(schedule: string, next: Date): number | null {
	const after = Bun.cron.parse(schedule, next.getTime() + 1_000, { tz: TZ });
	return after ? after.getTime() - next.getTime() : null;
}

/**
 * `Bun.cron` has no catch-up: a box that reboots at 03:00 with a `30 2 * * *` schedule waits until
 * the next night, and nothing says the night was skipped. So at start, if the newest set is older
 * than one whole interval, take one now. `BACKUP_CATCHUP=false` turns it off; `BACKUP_ON_START=true`
 * is the stronger form that runs unconditionally.
 */
async function catchUp(
	config: BackupConfig,
	intervalMs: number,
	log: Logger,
	runOnce: (trigger: 'catch-up') => Promise<void>,
): Promise<void> {
	// The freshness verdict `list` would give, against one interval rather than BACKUP_MAX_AGE.
	const result = await listBackups({ ...config, maxAgeMs: intervalMs }, log).catch(
		(error: unknown) => {
			log.warn('could not check for a missed run at start', { error: errorMessage(error) });
			return null;
		},
	);
	if (result === null || result.fresh) return;
	log.warn('the newest backup set is older than one schedule interval; running a catch-up backup', {
		newestAgeMs: result.newestAgeMs,
		intervalMs,
	});
	await runOnce('catch-up');
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
