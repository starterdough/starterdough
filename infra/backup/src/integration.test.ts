import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup, sha256 } from './backup';
import { main } from './cli';
import {
	type BackupConfig,
	configFromEnv,
	RELEASE_DIR,
	releaseConfig,
	withDatabase,
} from './config';
import { listBackups } from './list';
import { acquireLock, advisoryKey } from './lock';
import { createLogger } from './log';
import {
	dumpName,
	latestDumpStamp,
	type Manifest,
	manifestName,
	newestCompleteStamps,
	uploadsName,
} from './names';
import { run } from './proc';
import { drillDatabaseName, quoteIdentifier, restore } from './restore';
import { BackupBucket, type S3ClientLike } from './s3';

/**
 * End-to-end against a real cluster; needs pg_dump/pg_restore 17 on PATH and a database the test
 * may read (it never writes to it; the drill uses a scratch database that it drops again). The
 * database must hold at least one table with rows: a dump without table data fails verification.
 * Run it inside the image: `docker run --rm --network starterdough-dev_default
 * -e BACKUP_TEST_DATABASE_URL=postgres://starterdough:starterdough@postgres:5432/starterdough starterdough-backup bun test`.
 */
const databaseUrl = process.env.BACKUP_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('backup + drill against a live Postgres', () => {
	const lines: string[] = [];
	const log = createLogger((line) => lines.push(line));
	let root: string;
	let config: BackupConfig;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'starterdough-backup-it-'));
		const uploads = join(root, 'uploads');
		await mkdir(join(uploads, 'org_1'), { recursive: true });
		await Bun.write(join(uploads, 'org_1', 'doc_1'), 'hello uploads');
		config = configFromEnv({
			DATABASE_URL: databaseUrl,
			BACKUP_DIR: join(root, 'backups'),
			STORAGE_DIR: uploads,
			BACKUP_RETENTION_DAYS: '1',
		});
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('writes a complete set: dump, uploads archive and manifest', async () => {
		const summary = await runBackup(config, log);
		expect(summary.uploadsIncluded).toBe(true);
		expect(summary.bucket).toBeNull();
		expect(summary.heartbeat).toBe('skipped');
		expect(summary.pgDumpVersion).toMatch(/^\d+\.\d+/);
		expect(summary.files.map((file) => file.name)).toEqual([
			`starterdough_${summary.stamp}.dump`,
			`starterdough_${summary.stamp}.uploads.tar.gz`,
		]);
		for (const file of summary.files) {
			expect(file.bytes).toBeGreaterThan(0);
			expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		// The archive was opened with `pg_restore --list` and holds one entry per dumped table.
		expect(summary.tableEntries).toBeGreaterThan(0);

		const names = (await readdir(config.backupDir)).sort();
		expect(names).toEqual(
			[
				`starterdough_${summary.stamp}.dump`,
				`starterdough_${summary.stamp}.json`,
				`starterdough_${summary.stamp}.uploads.tar.gz`,
			].sort(),
		);
		const manifest = (await Bun.file(
			join(config.backupDir, manifestName(summary.stamp)),
		).json()) as Manifest;
		expect(manifest).toMatchObject({
			stamp: summary.stamp,
			database: config.database,
			pgDumpVersion: summary.pgDumpVersion,
			uploadsIncluded: true,
			files: summary.files,
			tableEntries: summary.tableEntries,
			warnings: config.warnings,
		});
		// The dump's checksum in the manifest is the checksum of the file on disk.
		const hasher = new Bun.CryptoHasher('sha256');
		hasher.update(
			await Bun.file(join(config.backupDir, `starterdough_${summary.stamp}.dump`)).bytes(),
		);
		expect(manifest.files[0]?.sha256).toBe(hasher.digest('hex'));

		const { sets, fresh } = await listBackups(config, log, null);
		expect(sets).toHaveLength(1);
		expect(sets[0]?.local.sort()).toEqual(['dump', 'manifest', 'uploads']);
		// The set was written moments ago, so the freshness check that gates `list`'s exit code passes.
		expect(fresh).toBe(true);
	});

	it('restores the latest dump into a scratch database, reports and drops it', async () => {
		const result = await restore(config, { name: 'latest', drill: true }, log);
		expect(result.mode).toBe('drill');
		expect(result.source).toBe('local');
		expect(result.ok).toBe(true);
		expect(result.report?.errors).toEqual([]);
		expect(result.report?.dropped).toBe(true);
		expect(result.report?.tableCount).toBeGreaterThan(0);
		expect(result.report?.uploadsEntries).toBeGreaterThan(0);
		expect(result.database).toMatch(
			new RegExp(`^starterdough_drill_${result.stamp.toLowerCase()}_[0-9a-f]{12}$`),
		);
		// Every table of the live database came back in the restored one.
		expect(result.report?.missingTables).toEqual([]);
		expect(result.report?.liveTableCount).toBe(result.report?.tableCount ?? 0);

		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		try {
			const rows = await admin.unsafe<{ datname: string }[]>(
				'select datname from pg_database where datname = $1',
				[result.database],
			);
			expect(rows).toHaveLength(0);
		} finally {
			await admin.close();
		}
	});

	it('uses every artifact from remote when the same-stamp local set is partial', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const names = [`starterdough_${stamp}.dump`, manifestName(stamp), uploadsName(stamp)];
		const objects = new Map<string, Uint8Array>();
		for (const name of names) {
			objects.set(`backups/${name}`, await Bun.file(join(config.backupDir, name)).bytes());
		}
		const client: S3ClientLike = {
			async list() {
				return {
					contents: [...objects].map(([key, value]) => ({ key, size: value.byteLength })),
					isTruncated: false,
				};
			},
			file(key: string) {
				const value = objects.get(key) ?? new Uint8Array();
				return new Blob([value.slice()]);
			},
			async stat(key: string) {
				const value = objects.get(key);
				if (!value) throw new Error('NoSuchKey');
				return { size: value.byteLength };
			},
			async write() {
				throw new Error('not used');
			},
			async delete() {},
		};
		const bucket = new BackupBucket(
			{
				bucket: 'test',
				endpoint: 'https://example.invalid',
				region: 'auto',
				accessKeyId: 'test',
				secretAccessKey: 'test',
				prefix: 'backups/',
				source: 'backup',
			},
			client,
		);
		const dumpPath = join(config.backupDir, names[0] as string);
		const manifestPath = join(config.backupDir, names[1] as string);
		const originalDump = await Bun.file(dumpPath).bytes();
		const originalManifest = await Bun.file(manifestPath).bytes();
		try {
			await Bun.write(dumpPath, 'same-stamp local partial must not win');
			await rm(manifestPath);
			const result = await restore(config, { name: 'latest', drill: true }, log, { bucket });
			expect(result.ok).toBe(true);
			expect(result.source).toBe('s3');
			expect(await Bun.file(dumpPath).bytes()).toEqual(originalDump);
		} finally {
			await Bun.write(dumpPath, originalDump);
			await Bun.write(manifestPath, originalManifest);
		}
	});

	it('does not reuse or delete a pre-existing drill database', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir));
		expect(stamp).not.toBeNull();
		const leftover = drillDatabaseName(
			config.database,
			stamp ?? '',
			'11111111-2222-3333-4444-555555555555',
		);
		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		try {
			await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(leftover)}`);
			const result = await restore(config, { name: 'latest', drill: true }, log);
			expect(result.report?.errors).toEqual([]);
			expect(result.ok).toBe(true);
			expect(result.database).not.toBe(leftover);
			const rows = await admin.unsafe<{ datname: string }[]>(
				'select datname from pg_database where datname = $1',
				[leftover],
			);
			expect(rows).toHaveLength(1);
		} finally {
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(leftover)} WITH (FORCE)`);
			await admin.close();
		}
	});

	it('refuses a live restore without --yes and says what it would do', async () => {
		const result = await restore(config, { name: 'latest' }, log);
		expect(result.ok).toBe(false);
		expect(result.mode).toBe('refused');
		const refusal = lines.map((line) => JSON.parse(line)).find((entry) => entry.wouldRun);
		expect(refusal?.wouldRun).toContain(
			'pg_restore --no-owner --no-privileges --exit-on-error --clean --if-exists --single-transaction',
		);
		// The password never reaches argv (it goes through PGPASSWORD), so it is not in the preview either.
		const url = new URL(databaseUrl as string);
		if (url.password) {
			expect(refusal?.wouldRun).toContain(`${url.username}@`);
			expect(refusal?.wouldRun).not.toContain(`:${url.password}@`);
		}
	});

	it('records row counts and the drill checks the restored ones against them', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const manifest = (await Bun.file(
			join(config.backupDir, manifestName(stamp)),
		).json()) as Manifest;
		expect(Object.keys(manifest.rowCounts ?? {}).length).toBeGreaterThan(0);

		const result = await restore(config, { name: stamp, drill: true }, log);
		expect(result.report?.errors).toEqual([]);
		expect(result.report?.rowCountsCompared).toBe(Object.keys(manifest.rowCounts ?? {}).length);
		expect(result.report?.shortTables).toEqual([]);
	});

	it('fails the drill when a table came back with fewer rows than the manifest recorded', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const path = join(config.backupDir, manifestName(stamp));
		const original = await Bun.file(path).text();
		const manifest = JSON.parse(original) as Manifest;
		const table = Object.keys(manifest.rowCounts ?? {})[0] as string;
		// What a restore whose data entries failed looks like from the outside: the tables are all
		// there, and one of them is nearly empty.
		await Bun.write(path, JSON.stringify({ ...manifest, rowCounts: { [table]: 100_000 } }));
		try {
			const result = await restore(config, { name: stamp, drill: true }, log);
			expect(result.ok).toBe(false);
			expect(result.report?.shortTables).toEqual([table]);
			expect(result.report?.errors.join(' ')).toContain('fall short of the manifest');
		} finally {
			await Bun.write(path, original);
		}
	});

	it('fails when a table recorded by the manifest is absent from the restored database', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const path = join(config.backupDir, manifestName(stamp));
		const original = await Bun.file(path).text();
		const manifest = JSON.parse(original) as Manifest;
		await Bun.write(
			path,
			JSON.stringify({
				...manifest,
				rowCounts: { ...manifest.rowCounts, table_that_was_not_restored: 1 },
			}),
		);
		try {
			const result = await restore(config, { name: stamp, drill: true }, log);
			expect(result.ok).toBe(false);
			expect(result.report?.errors.join(' ')).toContain(
				'tables recorded by the manifest are missing',
			);
		} finally {
			await Bun.write(path, original);
		}
	});

	it('refuses to restore an archive that does not match its manifest', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const dump = join(config.backupDir, `starterdough_${stamp}.dump`);
		const bytes = await Bun.file(dump).bytes();
		// One flipped byte in a data block: `pg_restore --list` still reads the table of contents
		// happily, which is exactly why the checksum has to be the check that decides.
		const corrupted = new Uint8Array(bytes);
		corrupted[bytes.length - 1] = (corrupted[bytes.length - 1] as number) ^ 0xff;
		await Bun.write(dump, corrupted);
		try {
			await expect(restore(config, { name: stamp, drill: true }, log)).rejects.toThrow(
				'does not match its manifest',
			);
			// The listing still passes: `pg_restore --list` reads only the table of contents.
			const listed = await run(['pg_restore', '--list', dump]);
			expect(listed.code).toBe(0);
		} finally {
			await Bun.write(dump, bytes);
		}
	});

	it('refuses a live restore into a database the manifest does not name', async () => {
		await expect(
			restore(config, { name: 'latest', yes: true, database: 'postgres' }, log),
		).rejects.toThrow(`was taken from database "${config.database}" and the target is "postgres"`);
	});

	it('fully stages uploads before changing the target database', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir)) as string;
		const archivePath = join(config.backupDir, uploadsName(stamp));
		const manifestPath = join(config.backupDir, manifestName(stamp));
		const originalArchive = await Bun.file(archivePath).bytes();
		const originalManifest = await Bun.file(manifestPath).text();
		const brokenArchive = new TextEncoder().encode('not a tar archive');
		const manifest = JSON.parse(originalManifest) as Manifest;
		const uploadsFile = manifest.files.find((file) => file.name === uploadsName(stamp));
		if (!uploadsFile) throw new Error(`manifest ${manifestPath} has no uploads archive`);
		const target = `${config.database}_restore_stage_probe`;
		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		const targetUrl = withDatabase(config.databaseUrl, target);
		try {
			await Bun.write(archivePath, brokenArchive);
			uploadsFile.bytes = brokenArchive.byteLength;
			uploadsFile.sha256 = await sha256(archivePath);
			await Bun.write(manifestPath, JSON.stringify(manifest));

			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)} WITH (FORCE)`);
			await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(target)}`);
			const setup = new Bun.SQL(targetUrl, { max: 1 });
			try {
				await setup.unsafe('create table restore_stage_sentinel (value text not null)');
				await setup.unsafe("insert into restore_stage_sentinel (value) values ('before')");
			} finally {
				await setup.close();
			}

			const restoreDir = join(root, 'failed-restore-uploads');
			await mkdir(restoreDir);
			await Bun.write(join(restoreDir, 'existing'), 'untouched');
			const restoreConfig: BackupConfig = {
				...config,
				uploads: { kind: 'directory', dir: restoreDir },
			};
			await expect(
				restore(
					restoreConfig,
					{
						name: stamp,
						yes: true,
						uploads: true,
						database: target,
						forceDatabaseMismatch: true,
						noSafetyDump: true,
					},
					log,
				),
			).rejects.toThrow('the database was not changed');

			const unchanged = new Bun.SQL(targetUrl, { max: 1 });
			try {
				const rows = await unchanged.unsafe<{ value: string }[]>(
					'select value from restore_stage_sentinel',
				);
				expect(rows).toEqual([{ value: 'before' }]);
			} finally {
				await unchanged.close();
			}
			expect(await readdir(restoreDir)).toEqual(['existing']);
			expect(await Bun.file(join(restoreDir, 'existing')).text()).toBe('untouched');
		} finally {
			await Bun.write(archivePath, originalArchive);
			await Bun.write(manifestPath, originalManifest);
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)} WITH (FORCE)`);
			await admin.close();
		}
	});

	it('restores into a throwaway database: writers block it, --terminate-connections does not', async () => {
		const target = `${config.database}_restore_probe`;
		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(target)}`);
		const holder = new Bun.SQL(withDatabase(config.databaseUrl, target), { max: 1 });
		const restoreDir = join(root, 'restored-uploads');
		await mkdir(join(restoreDir, 'org_1'), { recursive: true });
		await Bun.write(join(restoreDir, 'org_1', 'doc_1'), 'replace me');
		await Bun.write(join(restoreDir, 'unrelated'), 'retain me');
		const restoreConfig: BackupConfig = {
			...config,
			uploads: { kind: 'directory', dir: restoreDir },
		};
		try {
			await holder.unsafe('select 1');
			const options = {
				name: 'latest',
				yes: true,
				database: target,
				forceDatabaseMismatch: true,
				noSafetyDump: true,
			} as const;
			// A live writer must refuse the restore, never only warn.
			await expect(restore(config, options, log)).rejects.toThrow('other session(s) are connected');

			const result = await restore(
				restoreConfig,
				{ ...options, uploads: true, terminateConnections: true },
				log,
			);
			expect(result.ok).toBe(true);
			expect(result.mode).toBe('live');
			expect(result.uploadsRestored).toBe(true);
			expect(await Bun.file(join(restoreDir, 'org_1', 'doc_1')).text()).toBe('hello uploads');
			expect(await Bun.file(join(restoreDir, 'unrelated')).text()).toBe('retain me');
			expect(
				(await readdir(restoreDir)).some((name) => name.startsWith('.starterdough-restore-')),
			).toBe(false);
			const restored = new Bun.SQL(withDatabase(config.databaseUrl, target), { max: 1 });
			try {
				const tables = await restored.unsafe<{ n: number }[]>(
					"select count(*)::int as n from information_schema.tables where table_schema = 'public'",
				);
				expect(tables[0]?.n ?? 0).toBeGreaterThan(0);
			} finally {
				await restored.close();
			}
		} finally {
			await holder.close().catch(() => {});
			await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)} WITH (FORCE)`);
			await admin.close();
		}
	});

	it('refuses a second backup while one holds the lock', async () => {
		const held = await acquireLock(config.databaseUrl, config.database, 'test', log);
		try {
			await expect(runBackup(config, log)).rejects.toThrow(
				'another backup or restore is already working on',
			);
		} finally {
			await held.release();
		}
		// Released again, so the next run is not blocked by the one that finished.
		expect(advisoryKey(config.database)).toBe(advisoryKey(config.database));
	});

	it('waits for the lock when given a wait, and takes it once it is released', async () => {
		const held = await acquireLock(config.databaseUrl, config.database, 'test', log);
		const released = Bun.sleep(1_500).then(() => held.release());
		const before = lines.length;
		try {
			const summary = await runBackup({ ...config, lockWaitMs: 5_000 }, log);
			expect(summary.files.length).toBeGreaterThan(0);
			const messages = lines.slice(before).map((line) => JSON.parse(line).msg);
			expect(messages).toContain('waiting for the backup lock');
		} finally {
			await released;
		}
	}, 30_000);

	it('refuses after waiting when the lock stays held', async () => {
		const held = await acquireLock(config.databaseUrl, config.database, 'test', log);
		const started = performance.now();
		try {
			await expect(runBackup({ ...config, lockWaitMs: 1_000 }, log)).rejects.toThrow(
				/another backup or restore is already working on \S+ after waiting 1s/,
			);
			// It did wait, rather than only saying so.
			expect(performance.now() - started).toBeGreaterThanOrEqual(900);
		} finally {
			await held.release();
		}
	}, 30_000);

	describe('release sets', () => {
		// Stands in for both the bucket's endpoint and the heartbeat monitor. A release run must reach
		// neither, so every request it records is a failure.
		const requests: string[] = [];
		let server: ReturnType<typeof Bun.serve>;
		let env: Record<string, string>;

		beforeAll(() => {
			server = Bun.serve({
				port: 0,
				fetch(request) {
					requests.push(`${request.method} ${new URL(request.url).pathname}`);
					return new Response('not expected', { status: 500 });
				},
			});
			env = {
				DATABASE_URL: databaseUrl as string,
				BACKUP_DIR: config.backupDir,
				STORAGE_DIR: join(root, 'uploads'),
				BACKUP_S3_BUCKET: 'release-sets-stay-local',
				BACKUP_S3_ENDPOINT: server.url.origin,
				BACKUP_S3_ACCESS_KEY_ID: 'test',
				BACKUP_S3_SECRET_ACCESS_KEY: 'test',
				BACKUP_HEARTBEAT_URL: new URL('/ping', server.url).toString(),
			};
		});

		afterAll(async () => {
			await server.stop(true);
		});

		const entriesSince = (start: number) =>
			lines.slice(start).map((line) => JSON.parse(line) as Record<string, unknown>);

		it('keeps the newest four, never leaves the box and never pings the heartbeat', async () => {
			const releaseDir = join(config.backupDir, RELEASE_DIR);
			await mkdir(config.backupDir, { recursive: true });
			const nightly = (await readdir(config.backupDir)).filter((name) => name !== RELEASE_DIR);
			const before = lines.length;
			for (let run = 0; run < 6; run++) {
				// A stamp has one-second resolution, so each run starts in a second of its own.
				await Bun.sleep(1_000 - (Date.now() % 1_000));
				expect(await main(['backup', '--release'], env, log)).toBe(0);
			}

			expect(requests).toEqual([]);
			const runs = entriesSince(before).filter((entry) => entry.msg === 'backup complete');
			expect(runs).toHaveLength(6);
			for (const summary of runs) {
				expect(summary).toMatchObject({
					bucket: null,
					heartbeat: 'skipped',
					uploadsIncluded: false,
					// STORAGE_DIR is set above; the log must not claim otherwise.
					uploadsSkipped: 'a release set holds the database only',
				});
			}
			// Zero days of retention plus the floor of three: the set just written and three more.
			const kept = await readdir(releaseDir);
			expect([...newestCompleteStamps(kept, Number.POSITIVE_INFINITY)].sort()).toEqual(
				runs
					.slice(2)
					.map((summary) => summary.stamp as string)
					.sort(),
			);
			expect(kept).toHaveLength(8);
			expect((await readdir(config.backupDir)).filter((name) => name !== RELEASE_DIR)).toEqual(
				nightly,
			);

			const listed = lines.length;
			expect(await main(['list', '--release'], env, log)).toBe(0);
			expect(entriesSince(listed).find((entry) => entry.msg === 'backup sets')).toMatchObject({
				count: 4,
				dir: releaseDir,
				bucket: null,
			});
		}, 60_000);

		it('restores the newest release set in a drill', async () => {
			const before = lines.length;
			expect(await main(['restore', 'latest', '--release', '--drill'], env, log)).toBe(0);
			const newest = latestDumpStamp(await readdir(join(config.backupDir, RELEASE_DIR)));
			expect(
				entriesSince(before).find((entry) => entry.msg === 'restore drill complete'),
			).toMatchObject({ ok: true, source: 'local', stamp: newest });
			expect(requests).toEqual([]);
		}, 30_000);

		it('drills a release set without failing on the tables its deploy has added since', async () => {
			// A database of its own: this suite never writes to the one it is given.
			const migrated = `${config.database}_release_migrated`;
			const migratedUrl = withDatabase(config.databaseUrl, migrated);
			const releaseEnv = { DATABASE_URL: migratedUrl, BACKUP_DIR: join(root, 'migrated-release') };
			const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(migrated)} WITH (FORCE)`);
				await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(migrated)} TEMPLATE template0`);
				const sql = new Bun.SQL(migratedUrl, { max: 1 });
				try {
					await sql.unsafe('create table before_deploy (id int primary key)');
					await sql.unsafe('insert into before_deploy values (1)');
					expect(await main(['backup', '--release'], releaseEnv, log)).toBe(0);
					// What the deploy's migrations do once its restore point is taken.
					await sql.unsafe('create table added_by_deploy (id int primary key)');

					const before = lines.length;
					expect(await main(['restore', 'latest', '--release', '--drill'], releaseEnv, log)).toBe(
						0,
					);
					expect(
						entriesSince(before).find(
							(entry) => entry.msg === 'drill: the live database has tables this set predates',
						),
					).toMatchObject({ level: 'warn', tables: ['added_by_deploy'] });
					// Drilled the way a nightly set is, the same set fails on that table.
					const strict = await restore(
						releaseConfig(configFromEnv(releaseEnv)),
						{ name: 'latest', drill: true },
						log,
					);
					expect(strict.ok).toBe(false);
					expect(strict.report?.missingTables).toEqual(['added_by_deploy']);
				} finally {
					await sql.close();
				}
			} finally {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(migrated)} WITH (FORCE)`);
				await admin.close();
			}
		}, 30_000);

		it('rolls a migrated database back to its release set, or leaves it as it was', async () => {
			// A database of its own: this suite never writes to the one it is given.
			const migrated = `${config.database}_release_rollback`;
			const migratedUrl = withDatabase(config.databaseUrl, migrated);
			const releaseEnv = { DATABASE_URL: migratedUrl, BACKUP_DIR: join(root, 'rollback-release') };
			const releaseDir = join(releaseEnv.BACKUP_DIR, RELEASE_DIR);
			// A connection per call, closed again: a live restore refuses while anything is connected.
			const query = async <T = unknown[]>(...statements: string[]): Promise<T> => {
				const sql = new Bun.SQL(migratedUrl, { max: 1 });
				try {
					let last: unknown;
					for (const statement of statements) last = await sql.unsafe(statement);
					return last as T;
				} finally {
					await sql.close();
				}
			};
			// What a release's migrations do once the deploy's restore point is taken: a table with a
			// foreign key into one the set holds, which `pg_restore --clean` alone cannot drop around,
			// plus a column, a type, a function, a schema and the journal's row.
			const migrate = () =>
				query(
					"create type child_kind as enum ('new')",
					'create table child (id text primary key, parent_id text not null references parent (id), kind child_kind)',
					"insert into child values ('c1', 'p1', 'new')",
					'alter table parent add column archived boolean',
					'create function queue_child() returns trigger language plpgsql as $$ begin return new; end $$',
					'create trigger child_queue after insert on child for each row execute function queue_child()',
					'create schema reports',
					'create table reports.by_parent (parent_id text references public.parent (id))',
					"insert into drizzle.journal (hash) values ('0012')",
					"update parent set name = 'after'",
				);
			const state = async () => ({
				name: (await query<{ name: string }[]>('select name from parent'))[0]?.name,
				journal: (await query<{ n: number }[]>('select count(*)::int as n from drizzle.journal'))[0]
					?.n,
				filler: (await query<{ n: number }[]>('select count(*)::int as n from filler'))[0]?.n,
				added: (
					await query<{ name: string }[]>(
						`select relname as name from pg_class where relname in ('child', 'by_parent')
						 union all select proname from pg_proc where proname = 'queue_child'
						 union all select typname from pg_type where typname = 'child_kind'
						 union all select nspname from pg_namespace where nspname = 'reports'
						 order by 1`,
					)
				).map((row) => row.name),
			});
			const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(migrated)} WITH (FORCE)`);
				await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(migrated)} TEMPLATE template0`);
				await query(
					'create table parent (id text primary key, name text not null)',
					"insert into parent values ('p1', 'before')",
					'create schema drizzle',
					'create table drizzle.journal (id serial primary key, hash text not null)',
					"insert into drizzle.journal (hash) values ('0011')",
					// Enough rows that a dump cut short still lists, and fails part-way through its data.
					'create table filler (id int primary key, note text not null)',
					'insert into filler select g, md5(g::text) from generate_series(1, 50000) g',
				);
				expect(await main(['backup', '--release'], releaseEnv, log)).toBe(0);
				await migrate();
				const migratedState = {
					name: 'after',
					journal: 2,
					filler: 50000,
					added: ['by_parent', 'child', 'child_kind', 'queue_child', 'reports'],
				};
				expect(await state()).toEqual(migratedState);

				const stamp = latestDumpStamp(await readdir(releaseDir)) as string;
				const dumpPath = join(releaseDir, dumpName(stamp));
				const manifestPath = join(releaseDir, manifestName(stamp));
				const original = await Bun.file(dumpPath).bytes();
				try {
					// A set that fails half-way through its data: nothing it cleared or replaced stays.
					await Bun.write(dumpPath, original.subarray(0, Math.floor(original.length * 0.6)));
					await rename(manifestPath, `${manifestPath}.aside`);
					const restoreCut = ['restore', stamp, '--release', '--yes', '--no-manifest-check'];
					expect(await main([...restoreCut, '--no-safety-dump'], releaseEnv, log)).toBe(1);
					expect(await state()).toEqual(migratedState);
				} finally {
					await Bun.write(dumpPath, original);
					await rename(`${manifestPath}.aside`, manifestPath);
				}

				expect(await main(['restore', stamp, '--release', '--yes'], releaseEnv, log)).toBe(0);
				expect(await state()).toEqual({ name: 'before', journal: 1, filler: 50000, added: [] });
				const columns = await query<{ name: string }[]>(
					"select column_name as name from information_schema.columns where table_name = 'parent' order by 1",
				);
				expect(columns.map((column) => column.name)).toEqual(['id', 'name']);
				// The database is the set again, so the same migrations can run over it a second time.
				await migrate();
				expect(await state()).toEqual(migratedState);
			} finally {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(migrated)} WITH (FORCE)`);
				await admin.close();
			}
		}, 60_000);

		it('skips a database with no tables yet, the first deploy, and exits 0', async () => {
			const empty = `${config.database}_release_empty`;
			const dir = join(root, 'empty-release');
			const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
			try {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(empty)} WITH (FORCE)`);
				await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(empty)} TEMPLATE template0`);
				const before = lines.length;
				const code = await main(
					['backup', '--release'],
					{ DATABASE_URL: withDatabase(config.databaseUrl, empty), BACKUP_DIR: dir },
					log,
				);
				expect(code).toBe(0);
				expect(entriesSince(before).map((entry) => entry.msg)).toContain(
					'release backup skipped: the database has no tables yet (first deploy)',
				);
				expect(await readdir(dir).catch(() => [])).toEqual([]);
			} finally {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(empty)} WITH (FORCE)`);
				await admin.close();
			}
		});
	});
});
