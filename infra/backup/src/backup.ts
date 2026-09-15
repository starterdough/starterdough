import { access, constants, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type BackupConfig, ConfigError, detachPassword } from './config';
import { acquireLock } from './lock';
import type { Logger } from './log';
import {
	createManifest,
	dumpName,
	futureStamps,
	latestDumpStamp,
	type ManifestFile,
	manifestName,
	parseStamp,
	selectExpired,
	stampFor,
	uploadsName,
} from './names';
import {
	CommandError,
	parseVersion,
	run,
	runOrThrow,
	SHORT_COMMAND_TIMEOUT_MS,
	writeViaPartFile,
} from './proc';
import { BackupBucket } from './s3';

export interface BackupSummary {
	stamp: string;
	database: string;
	pgDumpVersion: string;
	files: ManifestFile[];
	/** `TABLE DATA` entries `pg_restore --list` found in the dump. */
	tableEntries: number;
	/** Rows per `public` table at dump time, or null when the count could not be taken. */
	rowCounts: Record<string, number> | null;
	uploadsIncluded: boolean;
	/** Why no uploads archive was made, when it was not. */
	uploadsSkipped: string | null;
	/** Why the uploads archive is incomplete, when tar reported unreadable or changed files. */
	uploadsDegraded: string | null;
	/** Bucket the set was copied to, or null for local-only. */
	bucket: string | null;
	uploadedKeys: string[];
	pruned: Pruned;
	heartbeat: 'sent' | 'failed' | 'skipped';
	durationMs: number;
}

export interface Pruned {
	local: string[];
	remote: string[];
}

/** A backup that could not be trusted: an unreadable archive, a truncated upload. */
export class BackupError extends Error {
	override name = 'BackupError';
}

/**
 * The heartbeat transport. Only the call signature is used, and `typeof fetch` in Bun also demands
 * `preconnect`, which nothing here calls and no stand-in should have to provide.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Seams for tests and for the CLI: the clock, the bucket client and the heartbeat transport. */
export interface BackupDeps {
	now?: () => Date;
	bucket?: BackupBucket;
	fetch?: FetchLike;
}

/**
 * Custom format is the only one pg_restore can restore selectively and in parallel; level 6 is
 * gzip's default trade-off. Grants are left out of the archive; ownership is not a dump-time
 * choice for custom format (`--no-owner` only affects plain SQL output) and is dropped by
 * `pg_restore --no-owner` in restore.ts, so the dump restores under whatever role the target
 * cluster uses. The URL must not carry a password: see {@link detachPassword}.
 */
export function pgDumpArgs(databaseUrl: string, outputPath: string): string[] {
	return [
		'pg_dump',
		'--format=custom',
		'--compress=6',
		'--no-privileges',
		'--file',
		outputPath,
		databaseUrl,
	];
}

/** Hidden prefix shared by restore staging and the backup exclusion that prevents archiving it. */
export const UPLOADS_STAGE_PREFIX = '.starterdough-restore-';

/** Archives the directory's contents (not the directory itself) so restores land in any `STORAGE_DIR`. */
export function tarCreateArgs(sourceDir: string, outputPath: string): string[] {
	return ['tar', '-czf', outputPath, `--exclude=./${UPLOADS_STAGE_PREFIX}*`, '-C', sourceDir, '.'];
}

/** Reads an archive's table of contents. Touches no database, so it is safe on any dump. */
export function pgRestoreListArgs(dumpPath: string): string[] {
	return ['pg_restore', '--list', dumpPath];
}

/**
 * `TABLE DATA` entries in a `pg_restore --list` table of contents, one per table pg_dump captured
 * rows for. Entry lines look like `3909; 0 16391 TABLE DATA public account starterdough`; everything
 * else in the listing is a comment (`;`) or another object kind. Zero entries means the archive
 * carries no data at all, however large the file is.
 */
export function countTableEntries(listing: string): number {
	return listing.split('\n').filter((line) => /^\d+;\s+\d+\s+\d+\s+TABLE DATA\b/.test(line.trim()))
		.length;
}

/** Leftover partial files older than this are garbage from a crashed run and get removed. */
const STALE_PART_MS = 24 * 3_600_000;

/**
 * The dump is not encrypted, so every run says so. `pg_dump` custom format is compressed, not
 * protected: whoever can read the `backups` volume or list the bucket can read every row. The
 * decision to leave it that way is deliberate (no key management in this tool, no `age` in the
 * image) but it must not be silent; see infra/backup/README.md for how to encrypt at rest.
 */
export const PLAINTEXT_NOTICE =
	'The dump is written unencrypted (pg_dump custom format is compressed, not encrypted): anyone who can read BACKUP_DIR or list the bucket can read every row, including password hashes and session tokens. Encrypt the volume and the bucket at rest, and keep the bucket credential write-only.';

export async function runBackup(
	config: BackupConfig,
	log: Logger,
	deps: BackupDeps = {},
): Promise<BackupSummary> {
	const started = performance.now();
	const now = deps.now?.() ?? new Date();
	const stamp = stampFor(now);
	// Logged per run, not once per process: the scheduler starts once and runs for months, and every
	// night's log has to carry what the setup does not cover (no bucket, documents left in S3).
	for (const warning of config.warnings) log.warn(warning);
	log.warn(PLAINTEXT_NOTICE);

	const bucket = deps.bucket ?? (config.s3 ? new BackupBucket(config.s3) : null);
	// Before anything is written: a manual backup taken while a restore is half-way through captures
	// a database in a state nothing can be restored from, and it looks like a good set afterwards.
	const lock = await acquireLock(config.databaseUrl, config.database, 'backup', log);
	try {
		const attempt = await produceSet(config, stamp, bucket, log).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		// Housekeeping is not part of the night's success: the disk that filled up is often why the
		// dump failed, so it gets pruned either way. The set just written is never a candidate.
		const pruned = await housekeep(config, bucket, now, stamp, log);
		if (!attempt.ok) throw attempt.error;

		const heartbeat = await sendBackupHeartbeat(
			config.heartbeatUrl,
			attempt.value.uploadsDegraded,
			log,
			deps.fetch ?? fetch,
		);
		return {
			...attempt.value,
			pruned,
			heartbeat,
			durationMs: Math.round(performance.now() - started),
		};
	} finally {
		await lock.release();
	}
}

type ProducedSet = Omit<BackupSummary, 'pruned' | 'heartbeat' | 'durationMs'>;

/** The night's artifacts: dump, verification, optional uploads archive, manifest and the copies. */
async function produceSet(
	config: BackupConfig,
	stamp: string,
	bucket: BackupBucket | null,
	log: Logger,
): Promise<ProducedSet> {
	await preflight(config, bucket, log);
	const pgDumpVersion = parseVersion(
		(await runOrThrow(['pg_dump', '--version'], { timeoutMs: SHORT_COMMAND_TIMEOUT_MS })).stdout,
	);
	const files: ManifestFile[] = [];

	const dump = dumpName(stamp);
	const dumpPath = join(config.backupDir, dump);
	log.info('pg_dump started', { database: config.database, file: dump, pgDumpVersion });
	const connection = detachPassword(config.databaseUrl);
	// The archive is opened while it is still the `.part` file, so a dump pg_restore cannot read
	// never becomes an artifact: writeViaPartFile deletes it and no later `restore latest` can pick
	// it as the newest set.
	const dumped = await writeViaPartFile(dumpPath, async (part) => {
		const result = await runOrThrow(pgDumpArgs(connection.url, part), {
			env: connection.env,
			timeoutMs: config.commandTimeoutMs,
		});
		return { durationMs: result.durationMs, ...(await inspectArchive(part)) };
	});
	const dumpFile: ManifestFile = {
		name: dump,
		bytes: await fileSize(dumpPath),
		sha256: await sha256(dumpPath),
	};
	files.push(dumpFile);
	log.info('pg_dump finished', { ...dumpFile, durationMs: dumped.durationMs });
	log.info('dump verified', {
		file: dump,
		tableEntries: dumped.tableEntries,
		durationMs: dumped.listMs,
	});

	const uploads = await archiveUploads(config, stamp, files, log);
	// Counted after the dump rather than inside its snapshot, so a database still taking writes
	// drifts by a few rows; the drill compares with {@link ROW_COUNT_TOLERANCE} for exactly that.
	const rowCounts = await countRows(config, log);

	const manifest = createManifest({
		stamp,
		database: config.database,
		pgDumpVersion,
		files,
		tableEntries: dumped.tableEntries,
		rowCounts,
		uploadsDegraded: uploads.degraded,
		warnings: config.warnings,
	});
	const manifestFile = manifestName(stamp);
	await Bun.write(
		join(config.backupDir, manifestFile),
		`${JSON.stringify(manifest, null, '\t')}\n`,
	);

	const uploadedKeys: string[] = [];
	if (bucket) {
		// The manifest goes last so a remote set that has one is known to be complete.
		for (const name of [...files.map((file) => file.name), manifestFile]) {
			uploadedKeys.push(await uploadVerified(bucket, join(config.backupDir, name), name, log));
		}
	} else {
		log.warn('no bucket configured; the backup stays on this machine only', {
			dir: config.backupDir,
		});
	}

	return {
		stamp,
		database: config.database,
		pgDumpVersion,
		files,
		tableEntries: dumped.tableEntries,
		rowCounts,
		uploadsIncluded: manifest.uploadsIncluded,
		uploadsSkipped: uploads.skipped,
		uploadsDegraded: uploads.degraded,
		bucket: bucket?.bucket ?? null,
		uploadedKeys,
	};
}

/**
 * Copies one artifact to the bucket and then asks the bucket what it holds. The number `put`
 * resolves to is what the client fed *from the local file*, so comparing it with that same file's
 * size is a tautology: it cannot fail, and a truncated or silently-dropped object passes. A HEAD is
 * the cheapest thing that involves the server at all.
 *
 * A mismatch is retried once with the bad object deleted first (a half-finished multipart upload,
 * a proxy that cut the body); a second mismatch fails the run, so the heartbeat stays silent and
 * the local copy remains the good one.
 */
export async function uploadVerified(
	bucket: BackupBucket,
	path: string,
	name: string,
	log: Logger,
): Promise<string> {
	const key = bucket.keyFor(name);
	const expected = await fileSize(path);
	const attempts = [1, 2] as const;
	for (const attempt of attempts) {
		const fed = await bucket.put(path, key);
		const stored = await bucket.statSize(key).catch((error: unknown) => {
			throw new BackupError(
				`uploaded ${name} but the bucket does not report an object at ${key}; the copy cannot be trusted`,
				{ cause: error },
			);
		});
		if (stored === expected) {
			log.info('uploaded', { bucket: bucket.bucket, key, bytes: stored, attempt });
			return key;
		}
		log.error('the bucket reports a different size than the local file', {
			bucket: bucket.bucket,
			key,
			stored,
			expected,
			fed,
			attempt,
		});
		await bucket
			.delete(key)
			.catch((error: unknown) => log.warn('could not delete the bad object', { key, error }));
		if (attempt === attempts.at(-1)) {
			throw new BackupError(
				`bucket ${bucket.bucket} reports ${stored} bytes for ${key} but the local file is ${expected} bytes, twice; the off-box copy of ${name} was deleted and the run failed`,
			);
		}
	}
	// The loop returns on success and throws on the last attempt; TypeScript cannot see that.
	throw new BackupError(`upload of ${name} neither succeeded nor failed`);
}

/** Tables whose rows the manifest records, so a drill can check the data came back and not only the table. */
const ROW_COUNT_QUERY =
	"select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name";

/**
 * `count(*)` per `public` table, bounded by a statement timeout: the numbers are what makes a drill
 * able to say "the rows came back" instead of "the tables exist", and a nightly job must not turn
 * into an hour of sequential scans on a database that has outgrown them. Failing to count is a
 * warning, never a failed backup: the dump itself is already verified.
 */
async function countRows(
	config: BackupConfig,
	log: Logger,
): Promise<Record<string, number> | null> {
	const sql = new Bun.SQL(config.databaseUrl, { max: 1 });
	const started = performance.now();
	try {
		await sql.unsafe(`set statement_timeout = ${ROW_COUNT_TIMEOUT_MS}`);
		const tables = await sql.unsafe<{ table_name: string }[]>(ROW_COUNT_QUERY);
		const counts: Record<string, number> = {};
		for (const { table_name } of tables) {
			const rows = await sql.unsafe<{ n: number }[]>(
				`select count(*)::int as n from public.${quoteIdentifier(table_name)}`,
			);
			counts[table_name] = rows[0]?.n ?? 0;
		}
		log.info('row counts recorded', {
			tables: tables.length,
			durationMs: Math.round(performance.now() - started),
		});
		return counts;
	} catch (error) {
		log.warn(
			'could not record row counts; the manifest will have none and a drill can only check the table list',
			{
				error,
				durationMs: Math.round(performance.now() - started),
			},
		);
		return null;
	} finally {
		await sql.close().catch(() => {});
	}
}

/** Ceiling on the whole row-count pass, as a Postgres `statement_timeout` per query. */
const ROW_COUNT_TIMEOUT_MS = 60_000;

/**
 * SQL identifier quoting, for the places a name cannot be a parameter (a table in a `count(*)`, a
 * database in `CREATE DATABASE`). Lives here because both the backup and the restore need it.
 */
export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Everything cheap that decides whether the run can succeed at all, before pg_dump spends an hour
 * producing something there is nowhere to put: a writable backups directory, the uploads mount with
 * the local storage driver, room on the disk, and a bucket credential that still works. The S3
 * *configuration* is validated in `configFromEnv`; only a real request finds a revoked key.
 */
async function preflight(
	config: BackupConfig,
	bucket: BackupBucket | null,
	log: Logger,
): Promise<void> {
	await mkdir(config.backupDir, { recursive: true });
	try {
		await access(config.backupDir, constants.W_OK);
	} catch (error) {
		throw new ConfigError(`BACKUP_DIR is not writable: ${config.backupDir}`, { cause: error });
	}
	if (config.uploads.kind === 'directory') await requireUploadsDir(config.uploads.dir);
	const space = await checkFreeSpace(config, log);
	let probed: string | null = null;
	if (bucket) {
		try {
			const { deleted } = await bucket.probe();
			probed = deleted ? 'write+stat+delete' : 'write+stat (delete denied)';
		} catch (error) {
			throw new BackupError(
				`the bucket credential does not work: ${bucket.bucket}/${bucket.prefix} rejected a probe object. Nothing was dumped`,
				{ cause: error },
			);
		}
	}
	// Ageing out is what makes a wrong clock recoverable; a stamp still in the future has to be said
	// out loud, because until real time catches up that set cannot be `latest`.
	const ahead = futureStamps(await readdir(config.backupDir));
	if (ahead.length > 0) {
		log.warn('backup sets are dated in the future; check this machine’s clock (NTP)', {
			stamps: ahead,
			effect: 'they are skipped by "restore latest" until the clock catches up',
		});
	}
	log.info('pre-flight ok', {
		dir: config.backupDir,
		uploads: config.uploads.kind === 'directory' ? config.uploads.dir : config.uploads.kind,
		bucket: config.s3 ? `${config.s3.bucket}/${config.s3.prefix}` : null,
		bucketProbe: probed,
		...space,
	});
}

/** Below this there is no point starting: not even a small dump plus its part file fits. */
const MIN_FREE_BYTES = 64 * 1024 * 1024;

/**
 * Free space on the backups filesystem against the size of the newest dump, the only estimate of
 * the next one available without taking it. Bun has no `statfs`, so this is `df -k`, which does not
 * exist on Windows: a developer checkout skips the check and says so in the pre-flight line.
 */
async function checkFreeSpace(
	config: BackupConfig,
	log: Logger,
): Promise<{ freeBytes: number | null }> {
	if (process.platform === 'win32') return { freeBytes: null };
	const result = await run(['df', '-k', config.backupDir], { timeoutMs: 10_000 });
	// `Filesystem 1K-blocks Used Available Use% Mounted on`: Available is the fourth column of the
	// last non-empty line, which is the mount point's row even when the device name wrapped.
	const line = result.stdout.trim().split('\n').at(-1) ?? '';
	const available = Number(line.trim().split(/\s+/)[3]);
	if (result.code !== 0 || !Number.isFinite(available)) {
		log.warn('could not read the free space of BACKUP_DIR', {
			dir: config.backupDir,
			detail: result.stderr.trim() || result.stdout.trim() || `df exited ${result.code}`,
		});
		return { freeBytes: null };
	}
	const freeBytes = available * 1024;
	if (freeBytes < MIN_FREE_BYTES) {
		throw new BackupError(
			`only ${freeBytes} bytes free on ${config.backupDir}; a dump cannot be written. Prune, enlarge the volume or lower BACKUP_RETENTION_DAYS`,
		);
	}
	const previous = await newestDumpBytes(config.backupDir);
	if (previous !== null && freeBytes < previous * 1.5) {
		log.warn('free space on BACKUP_DIR is tight for another dump of the last one’s size', {
			dir: config.backupDir,
			freeBytes,
			lastDumpBytes: previous,
		});
	}
	return { freeBytes };
}

async function newestDumpBytes(dir: string): Promise<number | null> {
	const names = await readdir(dir).catch(() => []);
	const stamp = latestDumpStamp(names);
	if (stamp === null) return null;
	const info = await stat(join(dir, dumpName(stamp))).catch(() => null);
	return info?.size ?? null;
}

/**
 * A configured `STORAGE_DIR` that is not there (a missing mount, a typo) fails the run: a heartbeat
 * must not vouch for a backup without the documents.
 */
export async function requireUploadsDir(dir: string): Promise<void> {
	if (!(await isDirectory(dir))) {
		throw new ConfigError(`STORAGE_DIR does not exist or is not a directory: ${dir}`);
	}
}

/**
 * Opens the finished archive with `pg_restore --list`. A pg_dump that exited 0 can still leave a
 * file no pg_restore will read (a disk that filled up, a broken compression stream), and the night
 * that finds out has to be the night of the dump rather than the day of the restore.
 */
async function inspectArchive(dumpPath: string): Promise<{ tableEntries: number; listMs: number }> {
	const listed = await run(pgRestoreListArgs(dumpPath), { timeoutMs: SHORT_COMMAND_TIMEOUT_MS });
	if (listed.code !== 0) {
		throw new BackupError('the dump is not a readable pg_restore archive', {
			cause: new CommandError('pg_restore', listed),
		});
	}
	const tableEntries = countTableEntries(listed.stdout);
	if (tableEntries === 0) {
		throw new BackupError(
			'the dump holds no table data: pg_restore --list found no TABLE DATA entries',
		);
	}
	return { tableEntries, listMs: listed.durationMs };
}

export interface UploadsOutcome {
	/** Why no archive was made at all. */
	skipped: string | null;
	/** Why the archive that *was* made is incomplete. Recorded in the manifest, not only logged. */
	degraded: string | null;
}

/**
 * Adds the uploads tarball to `files` when there is a directory to archive; reports why not, and
 * whether what it produced is complete.
 */
export async function archiveUploads(
	config: BackupConfig,
	stamp: string,
	files: ManifestFile[],
	log: Logger,
): Promise<UploadsOutcome> {
	const uploads = config.uploads;
	if (uploads.kind === 's3') {
		const reason = 'S3_BUCKET is set: documents already live in the bucket';
		log.info('uploads archive skipped', { reason });
		return { skipped: reason, degraded: null };
	}
	if (uploads.kind === 'none') {
		const reason = 'STORAGE_DIR is not set';
		log.info('uploads archive skipped', { reason });
		return { skipped: reason, degraded: null };
	}
	// Checked in the pre-flight as well; a mount can also go away between the two.
	await requireUploadsDir(uploads.dir);
	const name = uploadsName(stamp);
	const path = join(config.backupDir, name);
	log.info('tar started', { dir: uploads.dir, file: name });
	let degraded: string | null = null;
	const result = await writeViaPartFile(path, async (part) => {
		const archived = await run(tarCreateArgs(uploads.dir, part), {
			timeoutMs: config.commandTimeoutMs,
		});
		// Exit code 1 is tar's "some files differ" (GNU and bsdtar alike): a document written while
		// the archive was being made, or one it could not read. The archive is still valid for
		// everything else, and failing the whole night's backup over it would also lose the dump copy.
		// It does mean this set is not a complete copy of the documents, so it goes in the manifest:
		// a log line is gone by the time someone restores from the set months later.
		if (archived.code === 1 && !archived.killed) {
			degraded = `tar exited 1: files changed or could not be read while the archive was made — ${archived.stderr.trim() || '(no detail)'}`;
			log.warn('tar reported files that changed or could not be read; archive kept', {
				file: name,
				detail: archived.stderr.trim(),
			});
			return archived;
		}
		if (archived.code !== 0) throw new CommandError('tar', archived);
		return archived;
	});
	const file: ManifestFile = { name, bytes: await fileSize(path), sha256: await sha256(path) };
	files.push(file);
	log.info('tar finished', { ...file, durationMs: result.durationMs, degraded });
	return { skipped: null, degraded };
}

/**
 * Retention pruning and the stale-`.part` sweep, for after a backup attempt (whichever way it went)
 * and for the scheduler's start. It never throws: housekeeping that fails is logged, it does not
 * become the run's error. `keepStamp` is the set the caller has just written, never a candidate.
 */
async function housekeep(
	config: BackupConfig,
	bucket: BackupBucket | null,
	now: Date,
	keepStamp: string | null,
	log: Logger,
): Promise<Pruned> {
	const pruned: Pruned = { local: [], remote: [] };
	try {
		pruned.local = await pruneLocal(config, now, keepStamp, log);
	} catch (error) {
		log.error('local pruning failed', { dir: config.backupDir, error });
	}
	if (bucket) {
		pruned.remote = await pruneRemote(bucket, config.retentionDays, now, keepStamp, log);
	}
	return pruned;
}

/** Housekeeping on its own, so the scheduler tidies up at start instead of at the first tick. */
export async function runHousekeeping(
	config: BackupConfig,
	log: Logger,
	deps: BackupDeps = {},
): Promise<Pruned> {
	const bucket = deps.bucket ?? (config.s3 ? new BackupBucket(config.s3) : null);
	await mkdir(config.backupDir, { recursive: true });
	return housekeep(config, bucket, deps.now?.() ?? new Date(), null, log);
}

async function pruneLocal(
	config: BackupConfig,
	now: Date,
	keepStamp: string | null,
	log: Logger,
): Promise<string[]> {
	const entries = await readdir(config.backupDir);
	const candidates =
		keepStamp === null ? entries : entries.filter((name) => parseStamp(name) !== keepStamp);
	const removed: string[] = [];
	for (const name of selectExpired(candidates, config.retentionDays, now)) {
		await rm(join(config.backupDir, name), { force: true });
		removed.push(name);
		log.info('pruned local artifact', { file: name });
	}
	for (const name of entries.filter((entry) => entry.endsWith('.part'))) {
		const path = join(config.backupDir, name);
		const info = await stat(path).catch(() => null);
		if (info && now.getTime() - info.mtimeMs > STALE_PART_MS) {
			await rm(path, { force: true });
			log.warn('removed stale partial file from an interrupted run', { file: name });
		}
	}
	return removed;
}

/**
 * Remote pruning failures are logged, not thrown: the fresh backup is already safe in the bucket,
 * and the heartbeat should mean "a backup exists", not "retention housekeeping went smoothly".
 */
async function pruneRemote(
	bucket: BackupBucket,
	retentionDays: number,
	now: Date,
	keepStamp: string | null,
	log: Logger,
): Promise<string[]> {
	const removed: string[] = [];
	try {
		const keys = (await bucket.list())
			.map((object) => object.key)
			.filter((key) => keepStamp === null || parseStamp(key) !== keepStamp);
		for (const key of selectExpired(keys, retentionDays, now)) {
			await bucket.delete(key);
			removed.push(key);
			log.info('pruned remote artifact', { bucket: bucket.bucket, key });
		}
	} catch (error) {
		log.error('remote pruning failed', { bucket: bucket.bucket, error });
	}
	return removed;
}

/**
 * A known-incomplete uploads archive must page the monitor even though its database dump and
 * surviving files remain useful. The manifest retains the reason for a later restore.
 */
export async function sendBackupHeartbeat(
	url: string | undefined,
	uploadsDegraded: string | null,
	log: Logger,
	fetchImpl: FetchLike,
): Promise<BackupSummary['heartbeat']> {
	if (uploadsDegraded) {
		log.warn('backup set is degraded; sending a failure heartbeat', {
			detail: uploadsDegraded,
		});
	}
	return sendHeartbeat(url, log, fetchImpl, uploadsDegraded ? 'fail' : 'ok');
}

/** A heartbeat ping; exported so success, degradation and transport failures are testable. */
export async function sendHeartbeat(
	url: string | undefined,
	log: Logger,
	fetchImpl: FetchLike,
	outcome: 'ok' | 'fail' = 'ok',
): Promise<BackupSummary['heartbeat']> {
	if (!url) return 'skipped';
	return (await ping(url, outcome, log, fetchImpl)) ? 'sent' : 'failed';
}

/**
 * Tells the monitor a run failed so it alerts now instead of at the next missed ping. Only the
 * scheduler sends this: a human running a one-shot backup should not page anyone.
 */
export async function sendFailureHeartbeat(
	config: BackupConfig,
	log: Logger,
	deps: BackupDeps = {},
): Promise<void> {
	if (!config.heartbeatUrl) return;
	await sendHeartbeat(config.heartbeatUrl, log, deps.fetch ?? fetch, 'fail');
}

/**
 * A plain GET is what Healthchecks.io, Uptime Kuma push monitors and Better Stack heartbeats
 * expect, and `<url>/fail` is Healthchecks.io's convention for a failed run (a monitor that does
 * not know the suffix answers 404, which is only logged). A failing ping is never worth failing a
 * backup that already exists.
 */
async function ping(
	url: string,
	outcome: 'ok' | 'fail',
	log: Logger,
	fetchImpl: FetchLike,
): Promise<boolean> {
	const target = outcome === 'ok' ? url : `${url.replace(/\/+$/, '')}/fail`;
	try {
		const response = await fetchImpl(target, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			log.warn('heartbeat rejected', { status: response.status, outcome });
			return false;
		}
		log.info('heartbeat sent', { status: response.status, outcome });
		return true;
	} catch (error) {
		log.warn('heartbeat failed', { error, outcome });
		return false;
	}
}

async function fileSize(path: string): Promise<number> {
	return (await stat(path)).size;
}

/** Streamed so a dump larger than memory hashes fine; hex, the format `sha256sum` prints. */
export async function sha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	const reader = Bun.file(path).stream().getReader();
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		hasher.update(chunk.value);
	}
	return hasher.digest('hex');
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
