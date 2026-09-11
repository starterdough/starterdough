import { describe, expect, it } from 'bun:test';
import {
	createManifest,
	dumpName,
	futureStamps,
	groupByStamp,
	isManifest,
	isStamp,
	latestDumpStamp,
	manifestName,
	newestCompleteStamps,
	parseArtifact,
	parseStamp,
	RETENTION_FLOOR_SETS,
	selectExpired,
	stampFor,
	stampToDate,
	uploadsName,
} from './names';

const NOW = new Date('2026-09-09T02:30:00.000Z');

describe('stamps', () => {
	it('formats UTC instants as YYYYMMDDTHHMMSSZ and parses them back', () => {
		expect(stampFor(NOW)).toBe('20260909T023000Z');
		expect(stampFor(new Date('2026-01-01T00:00:00.999Z'))).toBe('20260101T000000Z');
		expect(stampToDate('20260909T023000Z')?.toISOString()).toBe('2026-09-09T02:30:00.000Z');
	});

	it('rejects malformed or impossible stamps', () => {
		expect(isStamp('20260909T023000Z')).toBe(true);
		expect(isStamp('20261309T023000Z')).toBe(false); // month 13
		expect(isStamp('20260230T023000Z')).toBe(false); // February 30th
		expect(isStamp('2026-09-09T02:30:00Z')).toBe(false);
		expect(isStamp('latest')).toBe(false);
		expect(stampToDate('20260909T023000')).toBeNull();
	});
});

describe('artifact names', () => {
	const stamp = '20260909T023000Z';

	it('names the three artifacts of a set', () => {
		expect(dumpName(stamp)).toBe('starterdough_20260909T023000Z.dump');
		expect(uploadsName(stamp)).toBe('starterdough_20260909T023000Z.uploads.tar.gz');
		expect(manifestName(stamp)).toBe('starterdough_20260909T023000Z.json');
	});

	it('parses file names and S3 keys, ignoring anything that is not ours', () => {
		expect(parseArtifact('starterdough_20260909T023000Z.dump')).toEqual({ stamp, kind: 'dump' });
		expect(parseArtifact('backups/starterdough_20260909T023000Z.uploads.tar.gz')).toEqual({
			stamp,
			kind: 'uploads',
		});
		expect(parseArtifact('a/b/starterdough_20260909T023000Z.json')).toEqual({
			stamp,
			kind: 'manifest',
		});
		expect(parseStamp('starterdough_20260909T023000Z.dump')).toBe(stamp);
		expect(parseStamp('starterdough_20260909T023000Z.dump.part')).toBeNull();
		expect(parseStamp('starterdough_20261309T023000Z.dump')).toBeNull();
		expect(parseStamp('org_1/doc_1')).toBeNull();
		expect(parseStamp('backup.sql.gz')).toBeNull();
		expect(parseStamp('starterdough_latest.dump')).toBeNull();
	});
});

describe('selectExpired', () => {
	// Four complete sets, all past a 14-day window, plus one half-written set and two foreign names.
	const names = [
		'starterdough_20260820T023000Z.dump',
		'starterdough_20260820T023000Z.json',
		'starterdough_20260821T023000Z.dump',
		'starterdough_20260821T023000Z.json',
		'starterdough_20260822T023000Z.dump',
		'starterdough_20260822T023000Z.json',
		'starterdough_20260823T023000Z.dump',
		'starterdough_20260823T023000Z.json',
		'starterdough_20260825T023000Z.dump', // no manifest: not a complete set
		'notes.txt',
		'org_1/doc_1',
	];

	it('selects artifacts older than the window, except those of the newest complete sets', () => {
		expect(selectExpired(names, 14, NOW)).toEqual([
			'starterdough_20260820T023000Z.dump',
			'starterdough_20260820T023000Z.json',
			'starterdough_20260825T023000Z.dump',
		]);
	});

	it('keeps the newest complete sets whatever the window says', () => {
		// One day of retention would leave nothing behind without the floor.
		expect(selectExpired(names, 1, NOW)).toEqual([
			'starterdough_20260820T023000Z.dump',
			'starterdough_20260820T023000Z.json',
			'starterdough_20260825T023000Z.dump',
		]);
		expect(newestCompleteStamps(names, RETENTION_FLOOR_SETS)).toEqual(
			new Set(['20260823T023000Z', '20260822T023000Z', '20260821T023000Z']),
		);
		// A dump without its manifest is half a backup and gets no protection.
		expect(newestCompleteStamps(['starterdough_20260909T023000Z.dump'], 3)).toEqual(new Set());
	});

	it('measures the window to the second', () => {
		const window = [
			'starterdough_20260826T022959Z.dump', // one second past the 14-day window
			'starterdough_20260826T023000Z.dump', // exactly 14 days old, still inside it
			'starterdough_20260908T023000Z.dump',
			'starterdough_20260909T023000Z.dump',
		];
		// None of these is a complete set, so the floor protects none of them.
		expect(selectExpired(window, 14, NOW)).toEqual(['starterdough_20260826T022959Z.dump']);
		expect(selectExpired(window, 365, NOW)).toEqual([]);
	});

	it('never selects foreign objects, so pruning is safe in a shared bucket', () => {
		const keys = [
			'backups/starterdough_20200101T000000Z.dump',
			'org_1/doc_1',
			'backups/readme.txt',
		];
		expect(selectExpired(keys, 14, NOW)).toEqual(['backups/starterdough_20200101T000000Z.dump']);
		// The same set with its manifest is complete, and the newest complete set is never pruned.
		expect(selectExpired([...keys, 'backups/starterdough_20200101T000000Z.json'], 14, NOW)).toEqual(
			[],
		);
	});
});

describe('grouping', () => {
	it('groups artifacts by stamp, newest first, and finds the latest dump', () => {
		const names = [
			'starterdough_20260908T023000Z.dump',
			'starterdough_20260909T023000Z.json',
			'starterdough_20260909T023000Z.dump',
			'starterdough_20260909T023000Z.uploads.tar.gz',
			'starterdough_20260910T023000Z.json', // manifest without a dump does not count as latest
			'junk',
		];
		const groups = groupByStamp(names);
		expect([...groups.keys()]).toEqual([
			'20260910T023000Z',
			'20260909T023000Z',
			'20260908T023000Z',
		]);
		expect(groups.get('20260909T023000Z')?.map((a) => a.kind)).toEqual([
			'manifest',
			'dump',
			'uploads',
		]);
		expect(latestDumpStamp(names)).toBe('20260909T023000Z');
		expect(latestDumpStamp(['junk'])).toBeNull();
	});

	it('does not let a stamp from the future become "latest", and reports it instead', () => {
		const now = new Date('2026-09-09T03:00:00Z');
		const names = [
			'starterdough_20260909T023000Z.dump',
			'starterdough_20260909T023000Z.json',
			// One NTP failure, two days ahead: without the guard this shadows every real set for
			// two days and then quietly stops doing so.
			'starterdough_20260911T023000Z.dump',
			'starterdough_20260911T023000Z.json',
		];
		expect(latestDumpStamp(names, now)).toBe('20260909T023000Z');
		expect(futureStamps(names, now)).toEqual(['20260911T023000Z']);

		// An hour of clock skew between the writer and the reader is not a wrong clock.
		const skewed = ['starterdough_20260909T033000Z.dump'];
		expect(latestDumpStamp(skewed, now)).toBe('20260909T033000Z');
		expect(futureStamps(skewed, now)).toEqual([]);
		// Once real time catches up, the set is selectable again.
		expect(latestDumpStamp(names, new Date('2026-09-11T03:00:00Z'))).toBe('20260911T023000Z');
	});
});

describe('manifest', () => {
	const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	it('records files with sizes and checksums, the table-entry count and the warnings', () => {
		const manifest = createManifest({
			stamp: '20260909T023000Z',
			database: 'starterdough',
			pgDumpVersion: '17.6',
			files: [
				{ name: 'starterdough_20260909T023000Z.dump', bytes: 1234, sha256: SHA },
				{ name: 'starterdough_20260909T023000Z.uploads.tar.gz', bytes: 56, sha256: SHA },
			],
			tableEntries: 21,
			rowCounts: { organization: 1, user: 3 },
			uploadsDegraded: 'tar exited 1: files changed',
			warnings: ['no bucket'],
		});
		expect(manifest).toEqual({
			stamp: '20260909T023000Z',
			createdAt: '2026-09-09T02:30:00.000Z',
			database: 'starterdough',
			pgDumpVersion: '17.6',
			uploadsIncluded: true,
			files: [
				{ name: 'starterdough_20260909T023000Z.dump', bytes: 1234, sha256: SHA },
				{ name: 'starterdough_20260909T023000Z.uploads.tar.gz', bytes: 56, sha256: SHA },
			],
			tableEntries: 21,
			rowCounts: { organization: 1, user: 3 },
			uploadsDegraded: 'tar exited 1: files changed',
			warnings: ['no bucket'],
		});
		// Row counts and a degradation note are only present when there is something to record, so a
		// manifest from a healthy run without them stays as small as it was.
		const plain = createManifest({
			stamp: '20260909T023000Z',
			database: 'starterdough',
			pgDumpVersion: '17.6',
			files: [{ name: 'starterdough_20260909T023000Z.dump', bytes: 1, sha256: SHA }],
			tableEntries: 1,
			rowCounts: null,
			uploadsDegraded: null,
			warnings: [],
		});
		expect(plain.uploadsIncluded).toBe(false);
		expect('rowCounts' in plain).toBe(false);
		expect('uploadsDegraded' in plain).toBe(false);
		expect(() =>
			createManifest({
				stamp: 'nope',
				database: 'starterdough',
				pgDumpVersion: '17',
				files: [],
				tableEntries: 0,
				rowCounts: null,
				uploadsDegraded: null,
				warnings: [],
			}),
		).toThrow('Invalid stamp');
	});

	it('round-trips through JSON and rejects anything of the wrong shape', () => {
		const manifest = createManifest({
			stamp: '20260909T023000Z',
			database: 'starterdough',
			pgDumpVersion: '17.6',
			files: [{ name: 'starterdough_20260909T023000Z.dump', bytes: 1234, sha256: SHA }],
			tableEntries: 21,
			rowCounts: { user: 3 },
			uploadsDegraded: null,
			warnings: ['no bucket'],
		});
		const readBack: unknown = JSON.parse(JSON.stringify(manifest));
		expect(isManifest(readBack)).toBe(true);
		expect(isManifest(readBack) && readBack.files[0]?.sha256).toBe(SHA);
		expect(isManifest(readBack) && readBack.tableEntries).toBe(21);
		expect(isManifest(readBack) && readBack.rowCounts?.user).toBe(3);
		expect(isManifest({ ...manifest, files: [{ name: 'x' }] })).toBe(false);
		expect(isManifest({ ...manifest, uploadsIncluded: 'yes' })).toBe(false);
		expect(isManifest({ ...manifest, tableEntries: '21' })).toBe(false);
		expect(isManifest({ ...manifest, rowCounts: { user: '3' } })).toBe(false);
		expect(isManifest({ ...manifest, rowCounts: [1] })).toBe(false);
		expect(isManifest({ ...manifest, uploadsDegraded: 1 })).toBe(false);
		expect(isManifest({ ...manifest, warnings: 'none' })).toBe(false);
		expect(isManifest({ ...manifest, files: [{ name: 'x', bytes: 1, sha256: 12 }] })).toBe(false);
		expect(isManifest(null)).toBe(false);
		expect(isManifest('{}')).toBe(false);
		expect(isManifest([])).toBe(false);
	});

	it('still reads a manifest written before the checksums existed', () => {
		const old = {
			stamp: '20260909T023000Z',
			createdAt: '2026-09-09T02:30:00.000Z',
			database: 'starterdough',
			pgDumpVersion: '17.6',
			uploadsIncluded: false,
			files: [{ name: 'starterdough_20260909T023000Z.dump', bytes: 1234 }],
		};
		expect(isManifest(old)).toBe(true);
	});
});
