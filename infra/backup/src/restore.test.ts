import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv } from './config';
import { createLogger } from './log';
import { parseStamp } from './names';
import {
	drillDatabaseName,
	pgRestoreArgs,
	promoteStagedUploads,
	quoteIdentifier,
	restoreSessionEnv,
	safetyDumpName,
	selectLatest,
	stageUploads,
	tarExtractArgs,
	tarListArgs,
} from './restore';

const DUMP = '/backups/starterdough_20260909T023000Z.dump';
const tmp = await mkdtemp(join(tmpdir(), 'starterdough-restore-unit-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('pg_restore arguments', () => {
	it('restores a drill into an empty database without dropping anything', () => {
		expect(
			pgRestoreArgs(
				'postgres://d:d@postgres:5432/starterdough_drill_20260909t023000z',
				DUMP,
				'drill',
			),
		).toEqual([
			'pg_restore',
			'--no-owner',
			'--no-privileges',
			// Without it a restore whose data entries nearly all failed still exits 0 and leaves the
			// same table list, which is how a drill comes to prove nothing.
			'--exit-on-error',
			'--dbname',
			'postgres://d:d@postgres:5432/starterdough_drill_20260909t023000z',
			DUMP,
		]);
	});

	it('replaces objects in place, in one transaction, for a live restore', () => {
		expect(pgRestoreArgs('postgres://d:d@postgres:5432/starterdough', DUMP, 'live')).toEqual([
			'pg_restore',
			'--no-owner',
			'--no-privileges',
			'--exit-on-error',
			'--clean',
			'--if-exists',
			'--single-transaction',
			'--dbname',
			'postgres://d:d@postgres:5432/starterdough',
			DUMP,
		]);
	});

	it('drops --single-transaction on request, for a schema that exhausts max_locks_per_transaction', () => {
		expect(
			pgRestoreArgs('postgres://d:d@postgres:5432/starterdough', DUMP, 'live', {
				noSingleTransaction: true,
			}),
		).not.toContain('--single-transaction');
		// The drill never wraps the restore: one failure would roll back the evidence of what worked.
		expect(pgRestoreArgs('postgres://d:d@postgres:5432/d', DUMP, 'drill')).not.toContain(
			'--single-transaction',
		);
	});

	it('bounds the restore session’s lock waits through PGOPTIONS, not the URL', () => {
		// On argv it would be visible to every process on the host, and it must not reach the
		// pre-restore pg_dump, which has to be allowed to wait.
		expect(restoreSessionEnv(60_000)).toEqual({ PGOPTIONS: '-c lock_timeout=60000' });
	});

	it('builds the tar commands for extracting and listing the uploads archive', () => {
		expect(tarExtractArgs('/backups/x.uploads.tar.gz', '/data/uploads')).toEqual([
			'tar',
			'-xzf',
			'/backups/x.uploads.tar.gz',
			'-C',
			'/data/uploads',
		]);
		expect(tarListArgs('/backups/x.uploads.tar.gz')).toEqual([
			'tar',
			'-tzf',
			'/backups/x.uploads.tar.gz',
		]);
	});
});

describe('selectLatest', () => {
	const local = [
		'starterdough_20260908T023000Z.dump',
		'starterdough_20260908T023000Z.json',
		'notes.txt',
	];
	const remote = (stamp: string) => [
		`backups/starterdough_${stamp}.dump`,
		`backups/starterdough_${stamp}.json`,
	];

	it('takes the newest dump of the two sides, not the newest local one', () => {
		expect(selectLatest(local, remote('20260909T023000Z'))).toEqual({
			stamp: '20260909T023000Z',
			source: 's3',
		});
		expect(selectLatest(local, remote('20260907T023000Z'))).toEqual({
			stamp: '20260908T023000Z',
			source: 'local',
		});
	});

	it('prefers the local copy of the same stamp, which needs no download', () => {
		expect(selectLatest(local, remote('20260908T023000Z'))).toEqual({
			stamp: '20260908T023000Z',
			source: 'local',
		});
	});

	it('works with only one side, and reports nothing when neither has a dump', () => {
		expect(selectLatest([], remote('20260909T023000Z'))).toEqual({
			stamp: '20260909T023000Z',
			source: 's3',
		});
		expect(selectLatest(local, [])).toEqual({ stamp: '20260908T023000Z', source: 'local' });
		// A manifest without its dump is not something to restore from.
		expect(selectLatest(['starterdough_20260909T023000Z.json'], ['backups/readme.txt'])).toBeNull();
		expect(selectLatest([], [])).toBeNull();
	});

	it('ignores a future-dated set on either side', () => {
		const now = new Date('2026-09-09T03:00:00Z');
		expect(selectLatest(local, remote('20270101T023000Z'), now)).toEqual({
			stamp: '20260908T023000Z',
			source: 'local',
		});
		expect(selectLatest(['starterdough_20270101T023000Z.dump'], [], now)).toBeNull();
	});
});

describe('pre-restore dump', () => {
	it('names it after the target database and the moment, outside the artifact pattern', () => {
		expect(safetyDumpName('starterdough', '20260909T023000Z')).toBe(
			'starterdough_20260909T023000Z_pre_restore.dump',
		);
		// Not an artifact name, so retention never prunes it and `list` never shows it as a set.
		expect(parseStamp(safetyDumpName('starterdough', '20260909T023000Z'))).toBeNull();
	});
});

describe('drill database naming', () => {
	it('uses a unique lower-case scratch name that PostgreSQL cannot truncate', () => {
		const one = drillDatabaseName(
			'a_database_name_that_is_far_longer_than_postgresql_identifiers_allow',
			'20260909T023000Z',
			'11111111-2222-3333-4444-555555555555',
		);
		const two = drillDatabaseName(
			'a_database_name_that_is_far_longer_than_postgresql_identifiers_allow',
			'20260909T023000Z',
			'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		);
		expect(one).toBe('starterdough_drill_20260909t023000z_111111112222');
		expect(two).not.toBe(one);
		expect(Buffer.byteLength(one)).toBeLessThanOrEqual(63);
	});

	it('quotes identifiers so mixed case and quotes survive', () => {
		expect(quoteIdentifier('user')).toBe('"user"');
		expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
	});
});

describe('uploads staging', () => {
	const log = createLogger(() => {});
	const config = configFromEnv({
		DATABASE_URL: 'postgres://starterdough@postgres:5432/starterdough',
	});

	it('rejects a broken archive and removes its staging directory', async () => {
		const dir = await mkdtemp(join(tmp, 'broken-'));
		const archive = join(dir, 'broken.tar.gz');
		const uploads = join(dir, 'uploads');
		await mkdir(uploads);
		await Bun.write(join(uploads, 'existing'), 'untouched');
		await Bun.write(archive, 'not a tar archive');

		await expect(stageUploads(config, { archive, dir: uploads }, log)).rejects.toThrow(
			'the database was not changed',
		);
		expect(await readdir(uploads)).toEqual(['existing']);
		expect(await Bun.file(join(uploads, 'existing')).text()).toBe('untouched');
	});

	it('merges staged directories, replaces archived files and retains unrelated live files', async () => {
		const dir = await mkdtemp(join(tmp, 'promote-'));
		const stage = join(dir, 'stage');
		const target = join(dir, 'target');
		await mkdir(join(stage, 'organization'), { recursive: true });
		await mkdir(join(target, 'organization'), { recursive: true });
		await Bun.write(join(stage, 'organization', 'replaced'), 'from backup');
		await Bun.write(join(stage, 'organization', 'new'), 'new from backup');
		await Bun.write(join(target, 'organization', 'replaced'), 'live value');
		await Bun.write(join(target, 'unrelated'), 'retained');

		await promoteStagedUploads(stage, target);
		expect(await Bun.file(join(target, 'organization', 'replaced')).text()).toBe('from backup');
		expect(await Bun.file(join(target, 'organization', 'new')).text()).toBe('new from backup');
		expect(await Bun.file(join(target, 'unrelated')).text()).toBe('retained');
		expect(await readdir(stage)).toEqual([]);
	});

	it('rejects a staged directory/file conflict before the database can change', async () => {
		const dir = await mkdtemp(join(tmp, 'conflict-'));
		const source = join(dir, 'source');
		const archive = join(dir, 'uploads.tar.gz');
		const uploads = join(dir, 'uploads');
		await mkdir(join(source, 'organization'), { recursive: true });
		await mkdir(uploads);
		await Bun.write(join(source, 'organization', 'document'), 'from backup');
		await Bun.write(join(uploads, 'organization'), 'live file');
		const archived = await Bun.spawn(['tar', '-czf', archive, '-C', source, '.']).exited;
		expect(archived).toBe(0);

		await expect(stageUploads(config, { archive, dir: uploads }, log)).rejects.toThrow(
			'the database was not changed',
		);
		expect(await readdir(uploads)).toEqual(['organization']);
		expect(await Bun.file(join(uploads, 'organization')).text()).toBe('live file');
	});
});
