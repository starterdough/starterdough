import type { S3Target } from './config';

/** The slice of `Bun.S3Client` this tool uses; tests substitute an in-memory fake. */
export interface S3ClientLike {
	write(path: string, data: Bun.BunFile | string): Promise<number>;
	list(input?: Bun.S3ListObjectsOptions | null): Promise<Bun.S3ListObjectsResponse>;
	delete(path: string): Promise<void>;
	file(path: string): Blob;
	/** HEAD on the object. This is the only call that reports what the *bucket* holds. */
	stat(path: string): Promise<Pick<Bun.S3Stats, 'size'>>;
}

export interface RemoteObject {
	key: string;
	size: number;
	lastModified: string | undefined;
}

/**
 * Thin wrapper over Bun's built-in `S3Client` (no SDK).
 * Uploads stream from disk and downloads stream to disk, so dumps larger than memory are fine.
 */
export class BackupBucket {
	readonly bucket: string;
	readonly prefix: string;
	private readonly client: S3ClientLike;

	constructor(target: S3Target, client?: S3ClientLike) {
		this.bucket = target.bucket;
		this.prefix = target.prefix;
		this.client =
			client ??
			new Bun.S3Client({
				bucket: target.bucket,
				endpoint: target.endpoint,
				region: target.region,
				accessKeyId: target.accessKeyId,
				secretAccessKey: target.secretAccessKey,
			});
	}

	/** Object key of an artifact name under the configured prefix. */
	keyFor(name: string): string {
		return `${this.prefix}${name}`;
	}

	/**
	 * Uploads a local file; resolves to the number of bytes the client says it fed from disk. That
	 * number comes from the local side, so it proves nothing about the object; {@link statSize}
	 * asks the bucket.
	 */
	async put(path: string, key: string): Promise<number> {
		return this.client.write(key, Bun.file(path));
	}

	/** Size the bucket reports for the key (HEAD). Throws when the object is not there. */
	async statSize(key: string): Promise<number> {
		return (await this.client.stat(key)).size;
	}

	/**
	 * Proves the credential can actually do the three things a run needs (write, HEAD, delete)
	 * against a throwaway key under the prefix, before `pg_dump` spends an hour. A revoked key, a
	 * bucket that no longer exists and a policy that only allows `ListBucket` all fail here.
	 * A delete that fails is reported rather than fatal: a write-only credential (the shape this
	 * bucket should have) may legitimately be denied it, and the probe object is tiny.
	 */
	async probe(): Promise<{ deleted: boolean }> {
		const key = `${this.prefix}.preflight`;
		const body = new Date().toISOString();
		await this.client.write(key, body);
		const stats = await this.client.stat(key);
		if (stats.size !== Buffer.byteLength(body)) {
			throw new Error(
				`bucket ${this.bucket} reported ${stats.size} bytes for a ${Buffer.byteLength(body)}-byte probe object (key ${key})`,
			);
		}
		try {
			await this.client.delete(key);
			return { deleted: true };
		} catch {
			return { deleted: false };
		}
	}

	/** Every object under the prefix (follows pagination beyond the 1000-key page size). */
	async list(prefix: string = this.prefix): Promise<RemoteObject[]> {
		const objects: RemoteObject[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await this.client.list({ prefix, continuationToken, maxKeys: 1000 });
			for (const entry of page.contents ?? []) {
				objects.push({ key: entry.key, size: entry.size ?? 0, lastModified: entry.lastModified });
			}
			continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
		} while (continuationToken);
		return objects;
	}

	async delete(key: string): Promise<void> {
		await this.client.delete(key);
	}

	/** Downloads an object to a local path; resolves to the number of bytes written. */
	async download(key: string, path: string): Promise<number> {
		return Bun.write(path, this.client.file(key));
	}
}
