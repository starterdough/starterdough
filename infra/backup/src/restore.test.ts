import { describe, expect, it } from 'bun:test';
import { parseStamp } from './names';
import {
	drillDatabaseName,
	pgRestoreArgs,
	quoteIdentifier,
	restoreSessionEnv,
	safetyDumpName,
	selectLatest,
	tarExtractArgs,
	tarListArgs,
} from './restore';

const DUMP = '/backups/starterdough_20260909T023000Z.dump';

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
			'--no-overwrite-dir',
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
	it('derives a lower-case scratch name from the database and the stamp', () => {
		expect(drillDatabaseName('starterdough', '20260909T023000Z')).toBe(
			'starterdough_drill_20260909t023000z',
		);
	});

	it('quotes identifiers so mixed case and quotes survive', () => {
		expect(quoteIdentifier('user')).toBe('"user"');
		expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
	});
});
