import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Target } from './config';
import { BackupBucket, type S3ClientLike } from './s3';

const target: S3Target = {
	bucket: 'starterdough-uploads',
	endpoint: undefined,
	region: 'auto',
	accessKeyId: undefined,
	secretAccessKey: undefined,
	prefix: 'backups/',
	source: 'uploads',
};

/**
 * In-memory stand-in that paginates like S3 does (1000 keys per page, continuation tokens).
 * `storedSize` makes the bucket report something other than what was fed to it, which is the case
 * the local byte count cannot see.
 */
export function fakeClient(
	keys: string[],
	pageSize = 2,
	storedSize?: (key: string, fed: number) => number,
) {
	const objects = new Map(keys.map((key) => [key, 10]));
	const calls: string[] = [];
	const client: S3ClientLike = {
		async write(path, data) {
			calls.push(`write ${path}`);
			const fed = typeof data === 'string' ? Buffer.byteLength(data) : data.size;
			objects.set(path, storedSize ? storedSize(path, fed) : fed);
			return fed;
		},
		async stat(path) {
			calls.push(`stat ${path}`);
			const size = objects.get(path);
			if (size === undefined) throw new Error(`NoSuchKey: ${path}`);
			return { size, lastModified: new Date(0), etag: 'etag', type: 'application/octet-stream' };
		},
		async list(input) {
			calls.push(`list ${input?.prefix ?? ''} ${input?.continuationToken ?? ''}`.trimEnd());
			const matching = [...objects.keys()]
				.filter((key) => key.startsWith(input?.prefix ?? ''))
				.sort();
			const start = input?.continuationToken ? Number(input.continuationToken) : 0;
			const page = matching.slice(start, start + pageSize);
			const isTruncated = start + pageSize < matching.length;
			return {
				contents: page.map((key) => ({ key, size: objects.get(key) })),
				isTruncated,
				nextContinuationToken: isTruncated ? String(start + pageSize) : undefined,
			};
		},
		async delete(path) {
			calls.push(`delete ${path}`);
			objects.delete(path);
		},
		file() {
			throw new Error('not used in this test');
		},
	};
	return { client, objects, calls };
}

const tmp = await mkdtemp(join(tmpdir(), 'starterdough-backup-s3-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('BackupBucket', () => {
	it('prefixes keys and uploads local files', async () => {
		const { client, objects } = fakeClient([]);
		const bucket = new BackupBucket(target, client);
		const path = join(tmp, 'starterdough_20260909T023000Z.json');
		await Bun.write(path, '{"stamp":"20260909T023000Z"}');

		const key = bucket.keyFor('starterdough_20260909T023000Z.json');
		expect(key).toBe('backups/starterdough_20260909T023000Z.json');
		expect(await bucket.put(path, key)).toBe(28);
		expect(objects.get(key)).toBe(28);
	});

	it('follows pagination and only lists the prefix', async () => {
		const keys = [
			'backups/starterdough_20260907T023000Z.dump',
			'backups/starterdough_20260908T023000Z.dump',
			'backups/starterdough_20260909T023000Z.dump',
			'backups/starterdough_20260909T023000Z.json',
			'backups/starterdough_20260909T023000Z.uploads.tar.gz',
			'org_1/doc_1',
		];
		const { client, calls } = fakeClient(keys, 2);
		const bucket = new BackupBucket(target, client);
		const listed = await bucket.list();
		expect(listed.map((object) => object.key)).toEqual(keys.slice(0, 5));
		expect(listed[0]).toEqual({
			key: 'backups/starterdough_20260907T023000Z.dump',
			size: 10,
			lastModified: undefined,
		});
		expect(calls).toEqual(['list backups/', 'list backups/ 2', 'list backups/ 4']);
	});

	it('deletes by key', async () => {
		const { client, objects } = fakeClient(['backups/starterdough_20260907T023000Z.dump']);
		const bucket = new BackupBucket(target, client);
		await bucket.delete('backups/starterdough_20260907T023000Z.dump');
		expect(objects.size).toBe(0);
	});

	it('reports the size the bucket holds, not the one that was fed to it', async () => {
		const { client } = fakeClient([], 2, () => 7);
		const bucket = new BackupBucket(target, client);
		const path = join(tmp, 'starterdough_20260910T023000Z.json');
		await Bun.write(path, '{"stamp":"20260910T023000Z"}');

		const key = bucket.keyFor('starterdough_20260910T023000Z.json');
		expect(await bucket.put(path, key)).toBe(28);
		expect(await bucket.statSize(key)).toBe(7);
		await expect(bucket.statSize('backups/missing')).rejects.toThrow('NoSuchKey');
	});

	it('probes write, stat and delete, and cleans the probe object up', async () => {
		const { client, objects, calls } = fakeClient([]);
		const bucket = new BackupBucket(target, client);
		expect(await bucket.probe()).toEqual({ deleted: true });
		expect(objects.size).toBe(0);
		expect(calls).toEqual([
			'write backups/.preflight',
			'stat backups/.preflight',
			'delete backups/.preflight',
		]);
	});

	it('accepts a probe it may not delete, and fails one the bucket stores short', async () => {
		const denied = fakeClient([]);
		denied.client.delete = async () => {
			throw new Error('AccessDenied');
		};
		expect(await new BackupBucket(target, denied.client).probe()).toEqual({ deleted: false });

		const short = fakeClient([], 2, () => 1);
		await expect(new BackupBucket(target, short.client).probe()).rejects.toThrow(
			'reported 1 bytes',
		);
	});
});
