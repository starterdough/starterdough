import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from './backup';
import { type BackupConfig, configFromEnv, withDatabase } from './config';
import { listBackups } from './list';
import { acquireLock, advisoryKey } from './lock';
import { createLogger } from './log';
import { latestDumpStamp, type Manifest, manifestName } from './names';
import { run } from './proc';
import { drillDatabaseName, quoteIdentifier, restore } from './restore';

/**
 * End-to-end against a real cluster; needs pg_dump/pg_restore 17 on PATH and a database the test
 * may read (it never writes to it — the drill uses a scratch database that it drops again). The
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
		expect(result.database).toBe(drillDatabaseName(config.database, result.stamp));
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

	it('drills again after one was interrupted before it could drop its database', async () => {
		const stamp = latestDumpStamp(await readdir(config.backupDir));
		expect(stamp).not.toBeNull();
		const leftover = drillDatabaseName(config.database, stamp ?? '');
		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		try {
			await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(leftover)}`);
		} finally {
			await admin.close();
		}

		const result = await restore(config, { name: 'latest', drill: true }, log);
		expect(result.report?.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.database).toBe(leftover);
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
			// The listing is not fooled into failing either — it passes, and used to be the only check.
			const listed = await run(['pg_restore', '--list', dump]);
			expect(listed.code).toBe(0);
		} finally {
			await Bun.write(dump, bytes);
		}
	});

	it('refuses a live restore into a database the manifest does not name', async () => {
		await expect(
			restore(config, { name: 'latest', yes: true, database: 'postgres' }, log),
		).rejects.toThrow('was taken from database "starterdough" and the target is "postgres"');
	});

	it('restores into a throwaway database: writers block it, --terminate-connections does not', async () => {
		const target = `${config.database}_restore_probe`;
		const admin = new Bun.SQL(withDatabase(config.databaseUrl, 'postgres'), { max: 1 });
		await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(target)} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(target)}`);
		const holder = new Bun.SQL(withDatabase(config.databaseUrl, target), { max: 1 });
		try {
			await holder.unsafe('select 1');
			const options = {
				name: 'latest',
				yes: true,
				database: target,
				forceDatabaseMismatch: true,
				noSafetyDump: true,
			} as const;
			// The check used to be a warning, so this restore went ahead under a live writer.
			await expect(restore(config, options, log)).rejects.toThrow('other session(s) are connected');

			const result = await restore(config, { ...options, terminateConnections: true }, log);
			expect(result.ok).toBe(true);
			expect(result.mode).toBe('live');
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
});
