import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	archiveUploads,
	countTableEntries,
	type FetchLike,
	pgDumpArgs,
	pgRestoreListArgs,
	runHousekeeping,
	sendFailureHeartbeat,
	sendHeartbeat,
	tarCreateArgs,
	uploadVerified,
} from './backup';
import { ConfigError, configFromEnv, type S3Target } from './config';
import { createLogger, type LogLevel } from './log';
import type { ManifestFile } from './names';
import { parseVersion } from './proc';
import { BackupBucket } from './s3';
import { fakeClient } from './s3.test';

describe('pg_dump arguments', () => {
	it('dumps in custom format without grants into the given file', () => {
		expect(
			pgDumpArgs(
				'postgres://starterdough@postgres:5432/starterdough',
				'/backups/starterdough_20260909T023000Z.dump.part',
			),
		).toEqual([
			'pg_dump',
			'--format=custom',
			'--compress=6',
			'--no-privileges',
			'--file',
			'/backups/starterdough_20260909T023000Z.dump.part',
			'postgres://starterdough@postgres:5432/starterdough',
		]);
	});

	it('archives the contents of the uploads directory, not the directory itself', () => {
		expect(tarCreateArgs('/data/uploads', '/backups/x.uploads.tar.gz.part')).toEqual([
			'tar',
			'-czf',
			'/backups/x.uploads.tar.gz.part',
			'-C',
			'/data/uploads',
			'.',
		]);
	});

	it('extracts the version number from pg_dump --version', () => {
		expect(parseVersion('pg_dump (PostgreSQL) 17.6\n')).toBe('17.6');
		expect(parseVersion('pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)')).toBe('17.6');
		expect(parseVersion('weird')).toBe('weird');
	});
});

describe('archive verification', () => {
	it('lists the archive without touching a database', () => {
		expect(pgRestoreListArgs('/backups/starterdough_20260909T023000Z.dump')).toEqual([
			'pg_restore',
			'--list',
			'/backups/starterdough_20260909T023000Z.dump',
		]);
	});

	// Trimmed from a real `pg_restore --list` of the dev database.
	const LISTING = `;
; Archive created at 2026-09-10 04:46:36 UTC
;     dbname: starterdough
;     TOC Entries: 133
;     Format: CUSTOM
;
; Selected TOC Entries:
;
7; 2615 16389 SCHEMA - drizzle starterdough
221; 1259 16399 TABLE public account starterdough
3937; 0 0 SEQUENCE OWNED BY drizzle __drizzle_migrations_id_seq starterdough
3909; 0 16391 TABLE DATA drizzle __drizzle_migrations starterdough
3910; 0 16399 TABLE DATA public account starterdough
4001; 2606 16405 CONSTRAINT public account account_pkey starterdough
`;

	it('counts the TABLE DATA entries and nothing else', () => {
		expect(countTableEntries(LISTING)).toBe(2);
		// A schema-only or empty archive has none, whatever else it lists.
		expect(countTableEntries('221; 1259 16399 TABLE public account starterdough\n')).toBe(0);
		expect(countTableEntries('')).toBe(0);
		// Not a listing at all (a truncated file, an error message on stdout).
		expect(countTableEntries('pg_restore: error: did not find magic string')).toBe(0);
	});
});

describe('uploads archive', () => {
	const log = createLogger(() => {});
	const DATABASE_URL = 'postgres://starterdough:secret@postgres:5432/starterdough';

	it('skips quietly when there is no directory to archive', async () => {
		const files: ManifestFile[] = [];
		const none = configFromEnv({ DATABASE_URL });
		expect((await archiveUploads(none, '20260909T023000Z', files, log)).skipped).toContain(
			'STORAGE_DIR',
		);
		const s3 = configFromEnv({
			DATABASE_URL,
			S3_BUCKET: 'starterdough-uploads',
			S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
			STORAGE_DIR: '/x',
		});
		expect((await archiveUploads(s3, '20260909T023000Z', files, log)).skipped).toContain(
			'S3_BUCKET',
		);
		expect(files).toEqual([]);
	});

	it('fails the run when STORAGE_DIR points at nothing, so the heartbeat stays silent', async () => {
		const missing = join(import.meta.dir, 'no-such-uploads-dir');
		const config = configFromEnv({ DATABASE_URL, STORAGE_DIR: missing });
		const files: ManifestFile[] = [];
		await expect(archiveUploads(config, '20260909T023000Z', files, log)).rejects.toBeInstanceOf(
			ConfigError,
		);
		await expect(archiveUploads(config, '20260909T023000Z', files, log)).rejects.toThrow(
			'STORAGE_DIR does not exist or is not a directory',
		);
		expect(files).toEqual([]);
	});
});

const tmp = await mkdtemp(join(tmpdir(), 'starterdough-backup-unit-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

const DB_URL = 'postgres://starterdough:secret@postgres:5432/starterdough';

const S3: S3Target = {
	bucket: 'starterdough-backups',
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	region: 'auto',
	accessKeyId: 'key',
	secretAccessKey: 'secret',
	prefix: 'backups/',
	source: 'backup',
};

describe('verifying the off-box copy', () => {
	const log = createLogger(() => {});

	it('asks the bucket what it holds and accepts a matching size', async () => {
		const path = join(tmp, 'starterdough_20260909T023000Z.dump');
		await Bun.write(path, 'x'.repeat(500));
		const { client, calls } = fakeClient([]);
		const bucket = new BackupBucket(S3, client);

		expect(await uploadVerified(bucket, path, 'starterdough_20260909T023000Z.dump', log)).toBe(
			'backups/starterdough_20260909T023000Z.dump',
		);
		// The HEAD is the whole point: without it the check compares the local file with itself.
		expect(calls).toEqual([
			'write backups/starterdough_20260909T023000Z.dump',
			'stat backups/starterdough_20260909T023000Z.dump',
		]);
	});

	it('deletes and retries once when the bucket reports a short object, then fails the run', async () => {
		const path = join(tmp, 'starterdough_20260910T023000Z.dump');
		await Bun.write(path, 'x'.repeat(500));
		const { client, calls, objects } = fakeClient([], 2, (_key, fed) => fed - 1);
		const bucket = new BackupBucket(S3, client);

		await expect(
			uploadVerified(bucket, path, 'starterdough_20260910T023000Z.dump', log),
		).rejects.toThrow('reports 499 bytes for backups/starterdough_20260910T023000Z.dump');
		expect(calls.filter((call) => call.startsWith('write'))).toHaveLength(2);
		// The truncated object is gone, so `list` cannot show the set as complete in the bucket.
		expect(objects.size).toBe(0);
	});

	it('succeeds on the retry when the first upload was the flaky one', async () => {
		const path = join(tmp, 'starterdough_20260911T023000Z.dump');
		await Bun.write(path, 'x'.repeat(500));
		let attempt = 0;
		const { client } = fakeClient([], 2, (_key, fed) => (++attempt === 1 ? 0 : fed));
		const bucket = new BackupBucket(S3, client);

		expect(await uploadVerified(bucket, path, 'starterdough_20260911T023000Z.dump', log)).toBe(
			'backups/starterdough_20260911T023000Z.dump',
		);
	});

	it('fails when the bucket has no object at all after the write', async () => {
		const path = join(tmp, 'starterdough_20260912T023000Z.dump');
		await Bun.write(path, 'x'.repeat(500));
		const { client } = fakeClient([]);
		client.stat = async () => {
			throw new Error('NoSuchKey');
		};
		await expect(
			uploadVerified(new BackupBucket(S3, client), path, 'starterdough_20260912T023000Z.dump', log),
		).rejects.toThrow('the bucket does not report an object');
	});
});

describe('pruning', () => {
	const log = createLogger(() => {});
	const now = new Date('2026-09-30T00:00:00Z');

	it('prunes past retention on both sides and keeps the newest complete sets', async () => {
		const dir = await mkdtemp(join(tmp, 'prune-'));
		// Four complete sets: three well past retention, one recent. The floor keeps the newest 3.
		const stamps = ['20260101T023000Z', '20260102T023000Z', '20260103T023000Z', '20260929T023000Z'];
		for (const stamp of stamps) {
			await Bun.write(join(dir, `starterdough_${stamp}.dump`), 'dump');
			await Bun.write(join(dir, `starterdough_${stamp}.json`), '{}');
		}
		await Bun.write(join(dir, 'starterdough.log'), 'not an artifact');
		const { client, objects } = fakeClient(
			stamps.flatMap((stamp) => [
				`backups/starterdough_${stamp}.dump`,
				`backups/starterdough_${stamp}.json`,
			]),
		);
		const config = {
			...configFromEnv({ DATABASE_URL: DB_URL }),
			backupDir: dir,
			retentionDays: 14,
		};

		const pruned = await runHousekeeping(config, log, {
			now: () => now,
			bucket: new BackupBucket(S3, client),
		});

		expect(pruned.local.sort()).toEqual([
			'starterdough_20260101T023000Z.dump',
			'starterdough_20260101T023000Z.json',
		]);
		expect(pruned.remote.sort()).toEqual([
			'backups/starterdough_20260101T023000Z.dump',
			'backups/starterdough_20260101T023000Z.json',
		]);
		// Nothing that is not one of ours is ever a candidate, in the directory or in the bucket.
		expect(await Bun.file(join(dir, 'starterdough.log')).text()).toBe('not an artifact');
		expect(objects.has('backups/starterdough_20260102T023000Z.dump')).toBe(true);
	});

	it('never lets a bucket failure become the run’s error', async () => {
		const dir = await mkdtemp(join(tmp, 'prune-fail-'));
		const { client } = fakeClient([]);
		client.list = async () => {
			throw new Error('AccessDenied');
		};
		const config = { ...configFromEnv({ DATABASE_URL: DB_URL }), backupDir: dir };
		const pruned = await runHousekeeping(config, log, {
			now: () => now,
			bucket: new BackupBucket(S3, client),
		});
		expect(pruned).toEqual({ local: [], remote: [] });
	});
});

describe('heartbeat', () => {
	const capture = () => {
		const lines: { level: LogLevel; line: string }[] = [];
		return { lines, log: createLogger((line, level) => lines.push({ level, line })) };
	};

	it('reports "sent" for a 2xx and "failed" for a rejected ping', async () => {
		const urls: string[] = [];
		const ok = capture();
		expect(
			await sendHeartbeat('https://hc.example/ping/abc', ok.log, async (input) => {
				urls.push(String(input));
				return new Response('OK');
			}),
		).toBe('sent');

		const bad = capture();
		expect(
			await sendHeartbeat(
				'https://hc.example/ping/abc',
				bad.log,
				async () => new Response('gone', { status: 404 }),
			),
		).toBe('failed');
		expect(bad.lines.some((entry) => entry.level === 'warn')).toBe(true);

		// A transport failure is the other way a monitor never hears from us.
		const thrown = capture();
		expect(
			await sendHeartbeat('https://hc.example/ping/abc', thrown.log, async () => {
				throw new Error('ENOTFOUND');
			}),
		).toBe('failed');
		expect(urls).toEqual(['https://hc.example/ping/abc']);
	});

	it('is "skipped", not "failed", when no URL is configured', async () => {
		const { log } = capture();
		expect(
			await sendHeartbeat(undefined, log, async () => {
				throw new Error('should not be called');
			}),
		).toBe('skipped');
	});

	it('pings <url>/fail for a failed scheduled run, without a double slash', async () => {
		const urls: string[] = [];
		const { log } = capture();
		const fetchImpl: FetchLike = async (input) => {
			urls.push(String(input));
			return new Response('OK');
		};
		const config = configFromEnv({
			DATABASE_URL: DB_URL,
			BACKUP_HEARTBEAT_URL: 'https://hc.example/ping/abc/',
		});
		await sendFailureHeartbeat(config, log, { fetch: fetchImpl });
		expect(urls).toEqual(['https://hc.example/ping/abc/fail']);

		// A one-shot backup with no heartbeat configured pages nobody.
		await sendFailureHeartbeat(configFromEnv({ DATABASE_URL: DB_URL }), log, { fetch: fetchImpl });
		expect(urls).toHaveLength(1);
	});
});
