import {
	access,
	constants,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
	countTableEntries,
	pgDumpArgs,
	pgRestoreListArgs,
	quoteIdentifier,
	sha256,
	UPLOADS_STAGE_PREFIX,
} from './backup';
import { type BackupConfig, detachPassword, redactUrl, withDatabase } from './config';
import { acquireLock } from './lock';
import type { Logger } from './log';
import {
	dumpName,
	futureStamps,
	isManifest,
	isStamp,
	latestDumpStamp,
	type Manifest,
	type ManifestFile,
	manifestName,
	parseArtifact,
	ROW_COUNT_TOLERANCE,
	stampFor,
	uploadsName,
} from './names';
import { CommandError, run, runOrThrow, SHORT_COMMAND_TIMEOUT_MS, writeViaPartFile } from './proc';
import { BackupBucket } from './s3';

export { quoteIdentifier };

export interface RestoreOptions {
	/** `latest`, a stamp (`20260909T023000Z`) or an artifact file name. */
	name: string;
	/** Target database for a live restore, or the base of the drill database name. */
	database?: string | undefined;
	drill?: boolean | undefined;
	yes?: boolean | undefined;
	uploads?: boolean | undefined;
	/** Skips the pre-restore dump of the current database (a live restore takes one by default). */
	noSafetyDump?: boolean | undefined;
	/** Restore even though the manifest says the dump came from a different database. */
	forceDatabaseMismatch?: boolean | undefined;
	/** Restore a set whose manifest is missing or unreadable, so nothing can be verified. */
	noManifestCheck?: boolean | undefined;
	/** Restore statement by statement instead of in one transaction; see {@link pgRestoreArgs}. */
	noSingleTransaction?: boolean | undefined;
	/** Disconnect other sessions instead of refusing the restore. */
	terminateConnections?: boolean | undefined;
}

export type RestoreMode = 'drill' | 'live';

export interface DrillReport {
	database: string;
	tableCount: number;
	tables: string[];
	/** Tables the live database has and the restored one does not; any at all fails the drill. */
	missingTables: string[];
	/** Tables in the live database, or null when it could not be inspected (no live database yet). */
	liveTableCount: number | null;
	/** Rows counted in the restored database, per table. */
	rowCounts: Record<string, number>;
	/** Tables whose restored row count fell short of the manifest's; any at all fails the drill. */
	shortTables: string[];
	/** How many tables' counts were compared with the manifest, or null when it recorded none. */
	rowCountsCompared: number | null;
	/** Entries in the uploads archive of the same set, or null when the set has none. */
	uploadsEntries: number | null;
	pgRestoreMs: number;
	dropped: boolean;
	errors: string[];
}

export interface RestoreResult {
	ok: boolean;
	mode: RestoreMode | 'refused';
	stamp: string;
	dumpPath: string;
	/** Where the dump was found. */
	source: 'local' | 's3';
	database: string;
	report?: DrillReport;
	uploadsRestored: boolean;
	/** Where the pre-restore dump of the target database went, or null when none was taken. */
	safetyDump: string | null;
	durationMs: number;
}

export class RestoreError extends Error {
	override name = 'RestoreError';
}

export interface RestoreDeps {
	bucket?: BackupBucket;
}

/**
 * A drill restores into an empty database, so nothing needs dropping; a live restore replaces
 * objects in place. The URL must not carry a password: see {@link detachPassword}.
 *
 * `--exit-on-error` on both: pg_restore's default is to log an error and carry on, which is how a
 * restore whose data entries nearly all failed still ends with exit 0 and a complete-looking table
 * list. A drill that proves nothing is worse than no drill.
 *
 * `--single-transaction` on a live restore, so a failure half-way leaves the database as it was
 * rather than a set of dropped objects and no replacements. The trade-off is real and is why
 * `--no-single-transaction` exists: together with `--clean` it needs the target to have no other
 * open connections at all, and one transaction dropping and recreating every object in a large
 * schema can exhaust `max_locks_per_transaction` (`ERROR: out of shared memory`). Raise
 * `max_locks_per_transaction` first; fall back to the flag only knowing a failure can leave the
 * database half-restored, which is what the pre-restore dump is for.
 */
export function pgRestoreArgs(
	targetUrl: string,
	dumpPath: string,
	mode: RestoreMode,
	options: { noSingleTransaction?: boolean | undefined } = {},
): string[] {
	const args = ['pg_restore', '--no-owner', '--no-privileges', '--exit-on-error'];
	if (mode === 'live') {
		args.push('--clean', '--if-exists');
		if (!options.noSingleTransaction) args.push('--single-transaction');
	}
	args.push('--dbname', targetUrl, dumpPath);
	return args;
}

/**
 * `lock_timeout` for the restore session only. Without it `pg_restore --clean` waits forever for
 * the `ACCESS EXCLUSIVE` lock a single leftover reader holds, and a restore that hangs at 03:00
 * looks exactly like one that is working. It goes in the environment rather than the URL so it
 * cannot leak into the pre-restore `pg_dump`, which must not be interrupted by a lock wait.
 */
export function restoreSessionEnv(lockTimeoutMs: number): Record<string, string> {
	return { PGOPTIONS: `-c lock_timeout=${lockTimeoutMs}` };
}

/** Extracts only into a newly created private staging directory, never the live uploads tree. */
export function tarExtractArgs(archivePath: string, targetDir: string): string[] {
	return ['tar', '-xzf', archivePath, '-C', targetDir];
}

export function tarListArgs(archivePath: string): string[] {
	return ['tar', '-tzf', archivePath];
}

/**
 * Name of the pre-restore dump: the target database, the moment the restore started and a suffix
 * that deliberately does not match the artifact pattern, so retention never prunes it and `list`
 * never shows it as a backup set.
 */
export function safetyDumpName(database: string, stamp: string): string {
	return `${database}_${stamp}_pre_restore.dump`;
}

/** Lower-cased so the name reads the same whether or not someone quotes it in psql. */
export function drillDatabaseName(
	_database: string,
	stamp: string,
	nonce: string = crypto.randomUUID(),
): string {
	// PostgreSQL silently truncates identifiers at 63 bytes. A fixed ASCII prefix plus a random
	// suffix stays below that boundary and cannot alias another deployment's long database name.
	return `starterdough_drill_${stamp.toLowerCase()}_${nonce.replaceAll('-', '').slice(0, 12)}`;
}

export async function restore(
	config: BackupConfig,
	options: RestoreOptions,
	log: Logger,
	deps: RestoreDeps = {},
): Promise<RestoreResult> {
	const started = performance.now();
	const bucket = deps.bucket ?? (config.s3 ? new BackupBucket(config.s3) : null);
	const located = await locateDump(config, options.name, bucket, log);
	const baseDatabase = options.database ?? config.database;
	const elapsed = () => Math.round(performance.now() - started);
	const base = { stamp: located.stamp, dumpPath: located.path, source: located.source };

	// The manifest is the only record of what this dump is and what it should weigh. Both a drill and
	// a live restore verify it: a drill that restores a corrupt archive proves nothing either.
	const manifest = await loadManifest(config, located.stamp, bucket, options, log, located.source);
	if (manifest) await verifyArtifact(config, manifest, dumpName(located.stamp), log);

	if (options.drill) {
		const report = await runDrill(config, located, baseDatabase, manifest, bucket, log);
		return {
			...base,
			ok: report.errors.length === 0 && report.dropped,
			mode: 'drill',
			database: report.database,
			report,
			uploadsRestored: false,
			safetyDump: null,
			durationMs: elapsed(),
		};
	}

	// Only for a live restore: a drill's target is its own scratch database, so a set from another
	// database is a perfectly sensible thing to drill.
	if (manifest) requireMatchingDatabase(manifest, baseDatabase, options, log);

	// Locate and verify the uploads before the confirmation. Extraction itself happens under the
	// restore lock, after --yes, but still before the database safety dump and destructive restore.
	const uploads = options.uploads
		? await prepareUploads(config, located.stamp, manifest, bucket, log, located.source)
		: null;

	const targetUrl = withDatabase(config.databaseUrl, baseDatabase);
	const connection = detachPassword(targetUrl);
	const args = pgRestoreArgs(connection.url, located.path, 'live', options);
	if (!options.yes) {
		log.warn('refusing to restore into a live database without --yes', {
			database: baseDatabase,
			target: redactUrl(targetUrl),
			dump: located.path,
			wouldRun: args.join(' '),
			manifest: manifest
				? `verified: from ${manifest.database}, ${manifest.tableEntries ?? '?'} table data entries`
				: 'none (checks skipped by --no-manifest-check)',
			uploads: uploads ? `would extract ${uploads.archive} into ${uploads.dir}` : 'not requested',
			safetyDump: options.noSafetyDump
				? 'disabled by --no-safety-dump'
				: `would dump ${baseDatabase} to ${join(config.backupDir, safetyDumpName(baseDatabase, '<now>'))} first`,
			hint: 'stop the api and worker services first, then re-run with --yes',
		});
		return {
			...base,
			ok: false,
			mode: 'refused',
			database: baseDatabase,
			uploadsRestored: false,
			safetyDump: null,
			durationMs: elapsed(),
		};
	}

	// Held across the pre-restore dump and the restore itself, so a scheduled backup cannot start
	// mid-restore and capture a database with half its objects dropped.
	const lock = await acquireLock(targetUrl, baseDatabase, `restore ${located.stamp}`, log);
	let stagedUploads: StagedUploads | null = null;
	let databaseRestored = false;
	try {
		// Everything that can still say no happens before `--clean --if-exists` drops a single object:
		// an archive pg_restore cannot open, writers still connected, uploads that cannot fully extract,
		// and the copy of what is about to be replaced.
		await requireReadableArchive(located.path, log);
		await requireNoWriters(targetUrl, baseDatabase, lock.pid, options, log);
		stagedUploads = uploads ? await stageUploads(config, uploads, log) : null;
		const safetyDump = options.noSafetyDump
			? null
			: await takeSafetyDump(config, baseDatabase, targetUrl, log);

		log.info('pg_restore started', {
			database: baseDatabase,
			target: redactUrl(targetUrl),
			dump: located.path,
			mode: 'live',
			singleTransaction: !options.noSingleTransaction,
			lockTimeoutMs: config.lockTimeoutMs,
		});
		const result = await runOrThrow(args, {
			env: { ...connection.env, ...restoreSessionEnv(config.lockTimeoutMs) },
			timeoutMs: config.commandTimeoutMs,
		});
		log.info('pg_restore finished', { database: baseDatabase, durationMs: result.durationMs });
		databaseRestored = true;

		if (stagedUploads) await installStagedUploads(stagedUploads, safetyDump, log);

		return {
			...base,
			ok: true,
			mode: 'live',
			database: baseDatabase,
			uploadsRestored: uploads !== null,
			safetyDump,
			durationMs: elapsed(),
		};
	} catch (error) {
		if (stagedUploads && !databaseRestored) await discardStagedUploads(stagedUploads, log);
		throw error;
	} finally {
		await lock.release();
	}
}

/**
 * Reads the set's manifest, from disk or the bucket. Without it nothing can be verified (not the
 * checksum, not which database the dump came from), so a live restore refuses rather than trusting
 * a file name. `--no-manifest-check` is the escape hatch for a set whose manifest is genuinely gone.
 */
async function loadManifest(
	config: BackupConfig,
	stamp: string,
	bucket: BackupBucket | null,
	options: RestoreOptions,
	log: Logger,
	preferredSource?: 'local' | 's3',
): Promise<Manifest | null> {
	const name = manifestName(stamp);
	const path = join(config.backupDir, name);
	if ((preferredSource === 's3' || !(await exists(path))) && bucket) {
		const key = bucket.keyFor(name);
		log.info('downloading manifest', { bucket: bucket.bucket, key });
		await writeViaPartFile(path, (part) => bucket.download(key, part)).catch((error: unknown) => {
			if (preferredSource === 's3') {
				throw new RestoreError(`could not download the selected remote manifest ${key}`, {
					cause: error,
				});
			}
			log.warn('could not download the manifest', { key, error });
		});
	}
	const parsed = await Bun.file(path)
		.json()
		.catch(() => null);
	if (isManifest(parsed)) {
		log.info('manifest loaded', {
			file: name,
			database: parsed.database,
			createdAt: parsed.createdAt,
			pgDumpVersion: parsed.pgDumpVersion,
			tableEntries: parsed.tableEntries,
			uploadsDegraded: parsed.uploadsDegraded,
		});
		return parsed;
	}
	if (options.noManifestCheck) {
		log.warn('no usable manifest for this set; restoring unverified because --no-manifest-check', {
			file: name,
		});
		return null;
	}
	throw new RestoreError(
		`${name} is missing or malformed, so nothing about ${dumpName(stamp)} can be verified: not its checksum and not which database it came from. Fetch the manifest, or pass --no-manifest-check to restore it unverified`,
	);
}

/**
 * Re-reads the artifact and compares it with the SHA-256 the manifest recorded when it was written.
 * This is the check that catches bit rot on the volume, a truncated download and an object a bucket
 * silently mangled, none of which `pg_restore --list` notices, because it reads the table of
 * contents and not a single data block.
 */
async function verifyArtifact(
	config: BackupConfig,
	manifest: Manifest,
	name: string,
	log: Logger,
): Promise<void> {
	const recorded: ManifestFile | undefined = manifest.files.find((file) => file.name === name);
	const path = join(config.backupDir, name);
	if (!recorded) {
		throw new RestoreError(`${manifest.stamp}'s manifest does not list ${name}`);
	}
	const bytes = (await stat(path)).size;
	if (bytes !== recorded.bytes) {
		throw new RestoreError(
			`${name} is ${bytes} bytes but its manifest says ${recorded.bytes}; the file is truncated or was replaced`,
		);
	}
	if (recorded.sha256 === undefined) {
		log.warn('manifest records no checksum for this artifact (written by an older version)', {
			file: name,
			bytes,
		});
		return;
	}
	const started = performance.now();
	const digest = await sha256(path);
	if (digest !== recorded.sha256) {
		throw new RestoreError(
			`${name} does not match its manifest: SHA-256 ${digest}, expected ${recorded.sha256}. This archive is corrupt — restore a different set`,
		);
	}
	log.info('checksum verified', {
		file: name,
		bytes,
		sha256: digest,
		durationMs: Math.round(performance.now() - started),
	});
}

/**
 * A dump from `staging` restored into `production` is the mistake this exists for. The file name
 * carries only a timestamp, so the manifest's database name is the only thing that distinguishes
 * them, and `restore <stamp> --yes` would otherwise do it without a word.
 */
function requireMatchingDatabase(
	manifest: Manifest,
	target: string,
	options: RestoreOptions,
	log: Logger,
): void {
	if (manifest.database === target) return;
	if (options.forceDatabaseMismatch) {
		log.warn('restoring a dump from another database because --force-database-mismatch', {
			dumpFrom: manifest.database,
			target,
		});
		return;
	}
	throw new RestoreError(
		`this dump was taken from database "${manifest.database}" and the target is "${target}". Restoring one deployment's data into another is almost never intended: check the stamp, use --database ${manifest.database}, or pass --force-database-mismatch if you really mean it`,
	);
}

/**
 * Proves the file is an archive pg_restore can open, before anything destructive runs. It is the
 * cheap first check, not the only one: `--list` reads the table of contents and decompresses no data
 * block, so a corrupt archive passes it. {@link verifyArtifact} is what catches that.
 */
async function requireReadableArchive(dumpPath: string, log: Logger): Promise<void> {
	const listed = await run(pgRestoreListArgs(dumpPath), { timeoutMs: SHORT_COMMAND_TIMEOUT_MS });
	if (listed.code !== 0) {
		throw new RestoreError(`${dumpPath} is not an archive pg_restore can read`, {
			cause: new CommandError('pg_restore', listed),
		});
	}
	log.info('dump verified', { dump: dumpPath, tableEntries: countTableEntries(listed.stdout) });
}

/**
 * Dumps the target database next to the backups before it is replaced, so a restore of the wrong
 * set (or a dump that turns out to be older than someone thought) is one `restore` away from
 * being undone. It is not a scheduled artifact: nothing prunes it and nothing uploads it, so the
 * operator decides when it goes.
 */
async function takeSafetyDump(
	config: BackupConfig,
	database: string,
	targetUrl: string,
	log: Logger,
): Promise<string> {
	const path = join(config.backupDir, safetyDumpName(database, stampFor(new Date())));
	const connection = detachPassword(targetUrl);
	log.info('pre-restore dump started', { database, file: path });
	try {
		const result = await writeViaPartFile(path, (part) =>
			runOrThrow(pgDumpArgs(connection.url, part), {
				env: connection.env,
				timeoutMs: config.commandTimeoutMs,
			}),
		);
		log.info('pre-restore dump finished', {
			file: path,
			bytes: (await stat(path)).size,
			durationMs: result.durationMs,
			hint: `to roll back: pg_restore --clean --if-exists --no-owner --no-privileges --dbname <url> ${path}`,
		});
	} catch (error) {
		throw new RestoreError(
			`could not dump ${database} before restoring into it; nothing was changed. Re-run with --no-safety-dump to restore anyway`,
			{ cause: error },
		);
	}
	return path;
}

interface LocatedDump {
	stamp: string;
	path: string;
	source: 'local' | 's3';
}

/**
 * The newest dump across both sides. Local wins a tie because it needs no download; anything newer
 * in the bucket wins outright, which is what "latest" has to mean on a box whose disk was replaced
 * or whose retention is shorter than the bucket's. Stamps dated in the future are not candidates;
 * see {@link latestDumpStamp}.
 */
export function selectLatest(
	localNames: string[],
	remoteKeys: string[],
	now: Date = new Date(),
): { stamp: string; source: 'local' | 's3' } | null {
	const local = latestDumpStamp(localNames, now);
	const remote = latestDumpStamp(remoteKeys, now);
	if (local !== null && (remote === null || local >= remote)) {
		return { stamp: local, source: 'local' };
	}
	return remote === null ? null : { stamp: remote, source: 's3' };
}

/** Finds the dump locally, otherwise downloads it into `BACKUP_DIR` from the bucket. */
async function locateDump(
	config: BackupConfig,
	name: string,
	bucket: BackupBucket | null,
	log: Logger,
): Promise<LocatedDump> {
	await mkdir(config.backupDir, { recursive: true });
	const local = await readdir(config.backupDir);
	let stamp: string | null;
	let preferredSource: 'local' | 's3' | undefined;
	if (name === 'latest') {
		const remoteKeys = bucket ? (await bucket.list()).map((object) => object.key) : [];
		const now = new Date();
		const ahead = futureStamps([...local, ...remoteKeys], now);
		if (ahead.length > 0) {
			log.warn('ignoring backup sets dated in the future when choosing "latest"', {
				stamps: ahead,
				hint: 'one machine’s clock was wrong; restore such a set by its stamp if it is the one you want',
			});
		}
		const latest = selectLatest(local, remoteKeys, now);
		if (latest === null) {
			throw new RestoreError(
				bucket
					? `no dumps found in ${config.backupDir} or in bucket ${bucket.bucket}`
					: `no dumps found in ${config.backupDir}`,
			);
		}
		stamp = latest.stamp;
		preferredSource = latest.source;
		log.info('latest dump selected', {
			stamp: latest.stamp,
			source: latest.source,
			local: latestDumpStamp(local, now),
			remote: bucket ? latestDumpStamp(remoteKeys, now) : null,
		});
	} else if (isStamp(name)) {
		stamp = name;
	} else {
		const parsed = parseArtifact(name);
		if (!parsed) {
			throw new RestoreError(
				`"${name}" is neither "latest", a stamp (YYYYMMDDTHHMMSSZ) nor a backup file name`,
			);
		}
		stamp = parsed.stamp;
	}

	const file = dumpName(stamp);
	const path = join(config.backupDir, file);
	if (preferredSource !== 's3' && local.includes(file)) return { stamp, path, source: 'local' };
	if (!bucket) throw new RestoreError(`${file} is not in ${config.backupDir}`);
	const key = bucket.keyFor(file);
	log.info('downloading dump', { bucket: bucket.bucket, key });
	try {
		const bytes = await writeViaPartFile(path, (part) => bucket.download(key, part));
		log.info('downloaded dump', { key, bytes });
	} catch (error) {
		throw new RestoreError(`${file} is not in ${config.backupDir} and could not be downloaded`, {
			cause: error,
		});
	}
	return { stamp, path, source: 's3' };
}

/** The uploads tarball of a set, fetched from the bucket when it is not on disk; null when the set has none. */
async function locateUploads(
	config: BackupConfig,
	stamp: string,
	bucket: BackupBucket | null,
	log: Logger,
	preferredSource?: 'local' | 's3',
): Promise<string | null> {
	const file = uploadsName(stamp);
	const path = join(config.backupDir, file);
	if (preferredSource !== 's3' && (await exists(path))) return path;
	if (!bucket) return null;
	const key = bucket.keyFor(file);
	const remote = await bucket.list(key);
	if (!remote.some((object) => object.key === key)) return null;
	log.info('downloading uploads archive', { bucket: bucket.bucket, key });
	const bytes = await writeViaPartFile(path, (part) => bucket.download(key, part));
	log.info('downloaded uploads archive', { key, bytes });
	return path;
}

/**
 * The drill proves the dump restores: create a scratch database next to the real one, restore
 * into it, look at what came back and drop it again. Every step's failure ends up in `errors`
 * rather than aborting, so the scratch database is dropped even when pg_restore fails.
 */
async function runDrill(
	config: BackupConfig,
	dump: LocatedDump,
	baseDatabase: string,
	manifest: Manifest | null,
	bucket: BackupBucket | null,
	log: Logger,
): Promise<DrillReport> {
	const database = drillDatabaseName(baseDatabase, dump.stamp);
	const report: DrillReport = {
		database,
		tableCount: 0,
		tables: [],
		missingTables: [],
		liveTableCount: null,
		rowCounts: {},
		shortTables: [],
		rowCountsCompared: null,
		uploadsEntries: null,
		pgRestoreMs: 0,
		dropped: false,
		errors: [],
	};
	// CREATE/DROP DATABASE must run from a different database of the same cluster.
	const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
	try {
		log.info('drill: creating database', { database });
		await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(database)}`);
	} catch (error) {
		await admin.close();
		throw new RestoreError(
			`drill: could not create database ${database}. The role in DATABASE_URL needs CREATEDB and a connectable "postgres" maintenance database in the same cluster`,
			{ cause: error },
		);
	}

	try {
		const drillUrl = withDatabase(config.databaseUrl, database);
		const connection = detachPassword(drillUrl);
		log.info('drill: pg_restore started', { database, dump: dump.path });
		const restored = await run(pgRestoreArgs(connection.url, dump.path, 'drill'), {
			env: { ...connection.env, ...restoreSessionEnv(config.lockTimeoutMs) },
			timeoutMs: config.commandTimeoutMs,
		});
		report.pgRestoreMs = restored.durationMs;
		if (restored.code !== 0) {
			report.errors.push(new CommandError('pg_restore', restored).message);
		} else {
			log.info('drill: pg_restore finished', { database, durationMs: restored.durationMs });
			await verify(drillUrl, withDatabase(config.databaseUrl, baseDatabase), manifest, report, log);
		}

		const uploads = await locateUploads(config, dump.stamp, bucket, log, dump.source).catch(
			(error: unknown) => {
				report.errors.push(`uploads archive: ${String(error)}`);
				return null;
			},
		);
		if (uploads) {
			let uploadsValid = true;
			if (manifest) {
				await verifyArtifact(config, manifest, uploadsName(dump.stamp), log).catch(
					(error: unknown) => {
						uploadsValid = false;
						report.errors.push(`uploads archive: ${String(error)}`);
					},
				);
				if (manifest.uploadsDegraded) {
					uploadsValid = false;
					report.errors.push(`uploads archive was incomplete: ${manifest.uploadsDegraded}`);
				}
			}
			if (uploadsValid) {
				await verifyDrillUploads(config, drillUrl, uploads, report, log);
			}
		} else if (manifest?.uploadsIncluded) {
			report.errors.push(
				`uploads archive: ${uploadsName(dump.stamp)} is listed by the manifest but was not found`,
			);
		}
	} catch (error) {
		report.errors.push(String(error instanceof Error ? error.message : error));
	} finally {
		try {
			// FORCE terminates anything still connected so the drop cannot be blocked.
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
			report.dropped = true;
			log.info('drill: dropped database', { database });
		} catch (error) {
			report.errors.push(
				`drop database: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await admin.close();
	}

	const ok = report.errors.length === 0 && report.dropped;
	const counts = Object.entries(report.rowCounts)
		.map(([table, count]) => `${table}=${count}`)
		.join(', ');
	const compared =
		report.liveTableCount === null ? 'not compared' : `${report.liveTableCount} live`;
	log[ok ? 'info' : 'error'](
		ok
			? `drill ok: ${report.tableCount} tables (${compared})${counts ? `, ${counts}` : ''}`
			: `drill failed: ${report.errors.join('; ')}`,
		{ ...report, stamp: dump.stamp, dump: dump.path },
	);
	return report;
}

async function rejectLinks(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const info = await lstat(path);
		if (info.isSymbolicLink())
			throw new RestoreError(`uploads archive contains a symlink: ${entry.name}`);
		if (info.isDirectory()) await rejectLinks(path);
		else if (!info.isFile())
			throw new RestoreError(`uploads archive contains a non-regular file: ${entry.name}`);
	}
}

/**
 * Extracts the archive into a private throwaway directory and proves that every ready document in
 * the restored database has the bytes that row names. Final-generation objects also carry the
 * committed promotion marker, which prevents a same-sized but different generation from passing.
 */
async function verifyDrillUploads(
	config: BackupConfig,
	drillUrl: string,
	archive: string,
	report: DrillReport,
	log: Logger,
): Promise<void> {
	const root = await mkdtemp(join(config.backupDir, '.starterdough-drill-uploads-'));
	try {
		const listed = await runOrThrow(tarListArgs(archive), { timeoutMs: SHORT_COMMAND_TIMEOUT_MS });
		report.uploadsEntries = listed.stdout.split('\n').filter((line) => line.trim()).length;
		await runOrThrow(tarExtractArgs(archive, root), { timeoutMs: config.commandTimeoutMs });
		await rejectLinks(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const PUBLIC_TABLES_QUERY =
	"select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name";

/** Row counts the drill reports when the manifest has none (a set from an older version). */
const FALLBACK_ROW_COUNT_TABLES = ['user', 'organization'];

/**
 * What the restored database actually contains, against what the live one does: a dump that
 * restores without an error but is missing a table (a `pg_dump --exclude-table` left in place, a
 * table created after the dump's schema was captured) is not a backup anyone can restore from.
 * Extra tables in the drill are expected (the live database has moved on since old sets), so only
 * missing ones fail. The live list is a nice-to-have: on a fresh box there is nothing to compare
 * against yet, and the drill still proves the dump restores.
 *
 * The row counts are the part that proves *data* came back rather than an empty schema. They are
 * compared with the manifest's, which is why they are worth taking at backup time.
 */
async function verify(
	drillUrl: string,
	liveUrl: string,
	manifest: Manifest | null,
	report: DrillReport,
	log: Logger,
): Promise<void> {
	const expected = manifest?.rowCounts ?? null;
	const sql = new Bun.SQL(drillUrl, { max: 1 });
	try {
		const tables = await sql.unsafe<{ table_name: string }[]>(PUBLIC_TABLES_QUERY);
		report.tables = tables.map((row) => row.table_name);
		report.tableCount = report.tables.length;
		if (report.tableCount === 0) report.errors.push('restored database has no tables in public');
		// Every table the manifest counted; without a manifest, the tables the app cannot live
		// without, so a drill of an old set still reports something a human can read.
		const wanted = expected ? Object.keys(expected) : FALLBACK_ROW_COUNT_TABLES;
		const missingExpected = wanted.filter((table) => !report.tables.includes(table));
		if (missingExpected.length > 0) {
			report.errors.push(
				`tables recorded by the manifest are missing from the restored database: ${missingExpected.join(', ')}`,
			);
		}
		for (const table of wanted) {
			if (!report.tables.includes(table)) continue;
			const rows = await sql.unsafe<{ n: number }[]>(
				`select count(*)::int as n from public.${quoteIdentifier(table)}`,
			);
			report.rowCounts[table] = rows[0]?.n ?? 0;
		}
	} finally {
		await sql.close();
	}

	if (expected) {
		report.rowCountsCompared = 0;
		for (const [table, wanted] of Object.entries(expected)) {
			const got = report.rowCounts[table];
			if (got === undefined) continue; // A missing table is reported by the table comparison below.
			report.rowCountsCompared++;
			// The manifest's counts are taken just after the dump, not inside its snapshot, so a
			// database still taking writes drifts. The failure worth catching is the gross one: a
			// restore whose data entries failed and left tables that exist and hold nothing.
			const floor = Math.floor(wanted * (1 - ROW_COUNT_TOLERANCE));
			if (got < floor || (wanted > 0 && got === 0)) report.shortTables.push(table);
		}
		if (report.shortTables.length > 0) {
			report.errors.push(
				`restored row counts fall short of the manifest's: ${report.shortTables
					.map((table) => `${table} ${report.rowCounts[table]} of ${expected[table]}`)
					.join(', ')}`,
			);
		}
	} else {
		log.warn(
			'drill: the manifest records no row counts, so the restored rows were not checked against anything',
			{ hint: 'sets written by an older version, or a backup whose count query timed out' },
		);
	}

	const live = await liveTables(liveUrl, log);
	if (live === null) return;
	report.liveTableCount = live.length;
	report.missingTables = live.filter((table) => !report.tables.includes(table));
	if (report.missingTables.length > 0) {
		report.errors.push(
			`tables in the live database are missing from the restored one: ${report.missingTables.join(', ')}`,
		);
	}
}

async function liveTables(liveUrl: string, log: Logger): Promise<string[] | null> {
	const sql = new Bun.SQL(liveUrl, { max: 1 });
	try {
		const tables = await sql.unsafe<{ table_name: string }[]>(PUBLIC_TABLES_QUERY);
		return tables.map((row) => row.table_name);
	} catch (error) {
		log.warn('drill: could not list the live database; skipping the table comparison', {
			target: redactUrl(liveUrl),
			error,
		});
		return null;
	} finally {
		await sql.close();
	}
}

/**
 * Refuses the restore while anything else is connected to the target. An API that keeps writing
 * during `--clean --if-exists` ends up with rows referencing objects that were dropped underneath
 * it, and `--single-transaction` together with `--clean` cannot take its locks at all while another
 * session holds them, so the restore hangs until `lock_timeout` and then rolls back an hour of work.
 *
 * `--terminate-connections` disconnects them instead, for the case where the writers are not under
 * the operator's control (a leaked pool, a forgotten psql).
 */
async function requireNoWriters(
	targetUrl: string,
	database: string,
	lockPid: number,
	options: RestoreOptions,
	log: Logger,
): Promise<void> {
	const sql = new Bun.SQL(targetUrl, { max: 1 });
	try {
		// Neither this connection nor the one holding the backup lock is a writer to warn about, and
		// terminating the lock session would release the lock this restore is running under.
		const rows = await sql.unsafe<{ pid: number; application_name: string; state: string }[]>(
			'select pid, application_name, state from pg_stat_activity where datname = $1 and pid <> pg_backend_pid() and pid <> $2',
			[database, lockPid],
		);
		if (rows.length === 0) return;
		if (!options.terminateConnections) {
			throw new RestoreError(
				`${rows.length} other session(s) are connected to ${database} (pids ${rows.map((row) => row.pid).join(', ')}); nothing was changed. Stop the writers (docker compose stop api worker) and re-run, or pass --terminate-connections to disconnect them`,
			);
		}
		// One statement per pid, deliberately. `... where pid <> pg_backend_pid() and
		// pg_terminate_backend(pid)` reads as if the filter runs first, but AND operands have no
		// evaluation order in SQL: Postgres called the terminate for every row and killed this very
		// session (and the one holding the restore lock) before reaching the comparison.
		const terminated: number[] = [];
		for (const row of rows) {
			await sql.unsafe('select pg_terminate_backend($1::int)', [row.pid]);
			terminated.push(row.pid);
		}
		log.warn('disconnected other sessions from the target database', {
			database,
			pids: terminated,
			hint: 'they will reconnect if their service is still running; stop it before the next restore',
		});
	} catch (error) {
		if (error instanceof RestoreError) throw error;
		throw new RestoreError(
			`could not inspect pg_stat_activity on ${database}, so it is not known whether writers are connected; nothing was changed`,
			{ cause: error },
		);
	} finally {
		await sql.close();
	}
}

export interface UploadsPlan {
	archive: string;
	dir: string;
}

export interface StagedUploads extends UploadsPlan {
	stageDir: string;
}

/**
 * Finds the archive and proves the target directory is writable, both before pg_restore runs:
 * the scheduler's container mounts the uploads read-only, and tar failing after the database was
 * already replaced would leave the two halves of the restore out of step.
 */
async function prepareUploads(
	config: BackupConfig,
	stamp: string,
	manifest: Manifest | null,
	bucket: BackupBucket | null,
	log: Logger,
	preferredSource?: 'local' | 's3',
): Promise<UploadsPlan> {
	if (config.uploads.kind !== 'directory') {
		throw new RestoreError(
			'--uploads needs the local storage driver: unset S3_BUCKET and point STORAGE_DIR at the uploads directory',
		);
	}
	const dir = config.uploads.dir;
	const archive = await locateUploads(config, stamp, bucket, log, preferredSource);
	if (!archive)
		throw new RestoreError(`${uploadsName(stamp)} was not found locally or in the bucket`);
	if (manifest) {
		await verifyArtifact(config, manifest, uploadsName(stamp), log);
		if (manifest.uploadsDegraded) {
			log.warn('this uploads archive was recorded as incomplete when it was made', {
				detail: manifest.uploadsDegraded,
			});
		}
	}
	try {
		await mkdir(dir, { recursive: true });
		await access(dir, constants.W_OK);
	} catch (error) {
		throw new RestoreError(
			`uploads directory is not writable: ${dir}. The scheduled container mounts it read-only; run the restore with a writable mount (see infra/backup/README.md)`,
			{ cause: error },
		);
	}
	return { archive, dir };
}

/**
 * Fully decompresses the archive before pg_restore. The staging directory is inside STORAGE_DIR,
 * so it uses the same mounted filesystem and proves that filesystem has the required capacity.
 */
export async function stageUploads(
	config: BackupConfig,
	{ archive, dir }: UploadsPlan,
	log: Logger,
): Promise<StagedUploads> {
	const stageDir = await mkdtemp(join(dir, UPLOADS_STAGE_PREFIX));
	log.info('staging uploads archive', { archive, dir, stageDir });
	try {
		const result = await runOrThrow(tarExtractArgs(archive, stageDir), {
			timeoutMs: config.commandTimeoutMs,
		});
		await validateStagedUploads(stageDir, dir);
		log.info('uploads archive staged', { stageDir, durationMs: result.durationMs });
		return { archive, dir, stageDir };
	} catch (error) {
		await rm(stageDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
			log.warn('could not remove failed uploads staging directory', {
				stageDir,
				error: cleanupError,
			});
		});
		throw new RestoreError(
			`could not fully extract the uploads archive into ${dir}; the database was not changed`,
			{ cause: error },
		);
	}
}

/**
 * Promotes a fully extracted tree with the restore's existing merge semantics: archived files
 * replace names that exist, archived directories merge, and unrelated live files remain.
 */
export async function promoteStagedUploads(stageDir: string, targetDir: string): Promise<void> {
	for (const entry of await readdir(stageDir, { withFileTypes: true })) {
		const source = join(stageDir, entry.name);
		const target = join(targetDir, entry.name);
		const current = await lstatIfExists(target);

		if (entry.isDirectory() && current?.isDirectory()) {
			await promoteStagedUploads(source, target);
			await rm(source, { recursive: true, force: true });
			continue;
		}
		if (current && entry.isDirectory() !== current.isDirectory()) {
			throw new RestoreError(
				`cannot restore uploads path ${target}: the archive and live storage disagree on whether it is a directory`,
			);
		}
		await rename(source, target);
	}
}

/** Detects deterministic directory/file conflicts before pg_restore changes the database. */
async function validateStagedUploads(stageDir: string, targetDir: string): Promise<void> {
	for (const entry of await readdir(stageDir, { withFileTypes: true })) {
		const source = join(stageDir, entry.name);
		const target = join(targetDir, entry.name);
		const current = await lstatIfExists(target);
		if (current && entry.isDirectory() !== current.isDirectory()) {
			throw new RestoreError(
				`cannot restore uploads path ${target}: the archive and live storage disagree on whether it is a directory`,
			);
		}
		if (entry.isDirectory() && current?.isDirectory()) {
			await validateStagedUploads(source, target);
		}
	}
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
		throw error;
	}
}

async function installStagedUploads(
	staged: StagedUploads,
	safetyDump: string | null,
	log: Logger,
): Promise<void> {
	const { archive, dir, stageDir } = staged;
	log.info('installing staged uploads', { archive, dir, stageDir });
	try {
		await promoteStagedUploads(stageDir, dir);
		await rm(stageDir, { recursive: true, force: true });
		log.info('uploads restored', { dir });
	} catch (error) {
		throw new RestoreError(
			`the database restore completed, but staged uploads could not be installed into ${dir}. Remaining staged files were kept at ${stageDir}. Fix the storage filesystem and re-run the same restore${
				safetyDump
					? `, or roll the database back from ${safetyDump}`
					: '; no pre-restore safety dump exists'
			}`,
			{ cause: error },
		);
	}
}

async function discardStagedUploads(staged: StagedUploads, log: Logger): Promise<void> {
	await rm(staged.stageDir, { recursive: true, force: true }).catch((error: unknown) => {
		log.warn('could not remove uploads staging directory after the restore stopped', {
			stageDir: staged.stageDir,
			error,
		});
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
