export type Env = Record<string, string | undefined>;

export interface S3Target {
	bucket: string;
	/** Undefined means AWS (Bun derives the endpoint from the region). */
	endpoint: string | undefined;
	region: string;
	accessKeyId: string | undefined;
	secretAccessKey: string | undefined;
	/** Key prefix inside the bucket, always ending in `/`. */
	prefix: string;
	/** Which variables the target came from: the dedicated `BACKUP_S3_*` set or the uploads bucket. */
	source: 'backup' | 'uploads';
}

export interface BackupConfig {
	databaseUrl: string;
	/** Database name from `DATABASE_URL`; the manifest records it and the drill derives its name from it. */
	database: string;
	backupDir: string;
	retentionDays: number;
	/** Cron expression interpreted in UTC by the `schedule` command. */
	schedule: string;
	/** Null keeps backups on the local disk only. */
	s3: S3Target | null;
	heartbeatUrl: string | undefined;
	/**
	 * Where uploaded documents live. Only a directory (the local storage driver) gets archived;
	 * whether it actually exists is checked at backup time, not here.
	 */
	uploads: UploadsSource;
	/** Run one backup as soon as `schedule` starts instead of waiting for the first tick. */
	runOnStart: boolean;
	/**
	 * On `schedule` start, run a backup when the newest set is older than one schedule interval.
	 * `Bun.cron` has no catch-up of its own, so a box that reboots at 03:00 with a 02:30 schedule
	 * silently skips the night.
	 */
	catchUp: boolean;
	/** `list` exits non-zero when the newest set is older than this. */
	maxAgeMs: number;
	/** Ceiling on `pg_dump`, `pg_restore` and `tar`; see {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
	commandTimeoutMs: number;
	/** `lock_timeout` for a restore session, so a live restore cannot block forever on a writer. */
	lockTimeoutMs: number;
	/** Non-fatal observations for the caller to log at startup. */
	warnings: string[];
}

export type UploadsSource =
	/** Local storage driver: `STORAGE_DIR` is archived alongside the dump. */
	| { kind: 'directory'; dir: string }
	/** S3 storage driver: the objects already live in a bucket, nothing to archive. */
	| { kind: 's3' }
	/** Local driver but no `STORAGE_DIR` given, so there is nothing to point tar at. */
	| { kind: 'none' };

export class ConfigError extends Error {
	override name = 'ConfigError';
}

export const DEFAULTS = {
	backupDir: './backups',
	retentionDays: 14,
	schedule: '30 2 * * *',
	s3Region: 'auto',
	s3Prefix: 'backups/',
	/** A day and a half: one missed nightly run is a warning, two are an outage. */
	maxAge: '36h',
	commandTimeoutMinutes: 360,
	lockTimeout: '60s',
} as const;

const DURATION_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `90s`, `45m`, `36h`, `2d`: one number and one unit. A bare number is rejected on purpose: the
 * same string means seconds to `lock_timeout` and days to retention, and guessing costs a backup.
 */
export function parseDuration(text: string): number | null {
	const match = /^(\d+)(s|m|h|d)$/.exec(text.trim());
	if (!match) return null;
	return Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
}

/**
 * Builds the configuration from environment variables. Empty strings count as unset because
 * `.env` files and Compose pass `S3_BUCKET=` for values that were never filled in.
 */
export function configFromEnv(env: Env): BackupConfig {
	const warnings: string[] = [];
	const databaseUrl = value(env, 'DATABASE_URL');
	if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
	const database = databaseName(databaseUrl);

	const retentionDays = integer(env, 'BACKUP_RETENTION_DAYS', DEFAULTS.retentionDays);
	if (retentionDays < 1) throw new ConfigError('BACKUP_RETENTION_DAYS must be a positive integer');

	const heartbeatUrl = value(env, 'BACKUP_HEARTBEAT_URL');
	if (heartbeatUrl && !isHttpUrl(heartbeatUrl)) {
		throw new ConfigError('BACKUP_HEARTBEAT_URL must be an http(s) URL');
	}
	if (!heartbeatUrl) {
		warnings.push(
			'No BACKUP_HEARTBEAT_URL set: nothing outside this box notices when the backups stop. A container that will not start, a full disk or an unreachable Postgres then fails silently until the day someone needs a restore. Point it at a Healthchecks.io check or an Uptime Kuma push monitor.',
		);
	}

	const commandTimeoutMinutes = integer(
		env,
		'BACKUP_COMMAND_TIMEOUT_MINUTES',
		DEFAULTS.commandTimeoutMinutes,
	);
	if (commandTimeoutMinutes < 1) {
		throw new ConfigError('BACKUP_COMMAND_TIMEOUT_MINUTES must be a positive integer');
	}

	const s3 = s3Target(env);
	if (!s3) {
		warnings.push(
			'No BACKUP_S3_BUCKET or S3_BUCKET set: backups stay on this machine only. Losing the box loses the backups too; configure a bucket to ship them off-site.',
		);
	}

	// With the S3 storage driver the documents are already objects in a bucket, so only the local
	// driver has an uploads directory worth archiving.
	const storageDir = value(env, 'STORAGE_DIR');
	const uploads: UploadsSource = value(env, 'S3_BUCKET')
		? { kind: 's3' }
		: storageDir
			? { kind: 'directory', dir: storageDir }
			: { kind: 'none' };
	if (uploads.kind === 's3') {
		warnings.push(
			'S3_BUCKET is set: the documents live in that bucket and this tool never archives them, so a backup set covers the database only. Enable object versioning and a lifecycle rule on the uploads bucket — without them an overwritten or deleted document has no copy anywhere.',
		);
	}

	return {
		databaseUrl,
		database,
		backupDir: value(env, 'BACKUP_DIR') ?? DEFAULTS.backupDir,
		retentionDays,
		schedule: value(env, 'BACKUP_SCHEDULE') ?? DEFAULTS.schedule,
		s3,
		heartbeatUrl,
		uploads,
		runOnStart: flag(env, 'BACKUP_ON_START', false),
		catchUp: flag(env, 'BACKUP_CATCHUP', true),
		maxAgeMs: duration(env, 'BACKUP_MAX_AGE', DEFAULTS.maxAge),
		commandTimeoutMs: commandTimeoutMinutes * 60_000,
		lockTimeoutMs: duration(env, 'BACKUP_LOCK_TIMEOUT', DEFAULTS.lockTimeout),
		warnings,
	};
}

/**
 * Dedicated bucket first; otherwise the uploads bucket under a prefix, so a single R2/S3 bucket
 * covers both documents and backups. Each `BACKUP_S3_*` value falls back to its `S3_*` twin, which
 * is what Bun's client would do implicitly anyway (it reads `S3_ENDPOINT` etc. from the process
 * environment); spelling it out keeps the behaviour visible and testable.
 */
function s3Target(env: Env): S3Target | null {
	const backupBucket = value(env, 'BACKUP_S3_BUCKET');
	const uploadsBucket = value(env, 'S3_BUCKET');
	const bucket = backupBucket ?? uploadsBucket;
	if (!bucket) return null;
	const pick = (name: string) => value(env, `BACKUP_S3_${name}`) ?? value(env, `S3_${name}`);
	// Each pair is checked on its own prefix: a BACKUP_S3_ACCESS_KEY_ID whose secret comes from
	// S3_SECRET_ACCESS_KEY is two halves of two identities, and the request is signed with neither.
	requireCredentialPair(env, 'BACKUP_S3_');
	requireCredentialPair(env, 'S3_');
	const endpoint = pick('ENDPOINT');
	const region = pick('REGION') ?? DEFAULTS.s3Region;
	// `auto` is Cloudflare R2's pseudo-region and only means anything to an S3-compatible endpoint.
	// Against AWS (no endpoint: Bun derives it from the region) it would sign for a region that does
	// not exist, which fails at upload time (after the dump) rather than here.
	if (region === DEFAULTS.s3Region && !endpoint) {
		throw new ConfigError(
			`BACKUP_S3_REGION (or S3_REGION) is "${DEFAULTS.s3Region}", which needs an explicit BACKUP_S3_ENDPOINT (or S3_ENDPOINT), as on Cloudflare R2. With no endpoint set a real AWS region such as us-east-1 is required.`,
		);
	}
	return {
		bucket,
		endpoint,
		region,
		accessKeyId: pick('ACCESS_KEY_ID'),
		secretAccessKey: pick('SECRET_ACCESS_KEY'),
		prefix: normalizePrefix(value(env, 'BACKUP_S3_PREFIX') ?? DEFAULTS.s3Prefix),
		source: backupBucket ? 'backup' : 'uploads',
	};
}

/**
 * Key id and secret of one prefix are set together or not at all. Half a pair is worse than none:
 * Bun's S3 client silently completes the missing half from the process environment, so the upload
 * either fails with a signature error or lands under an identity nobody chose.
 */
function requireCredentialPair(env: Env, prefix: string): void {
	const keyId = value(env, `${prefix}ACCESS_KEY_ID`);
	const secret = value(env, `${prefix}SECRET_ACCESS_KEY`);
	if (Boolean(keyId) !== Boolean(secret)) {
		throw new ConfigError(
			`${prefix}ACCESS_KEY_ID and ${prefix}SECRET_ACCESS_KEY must be set together; ${keyId ? `${prefix}SECRET_ACCESS_KEY` : `${prefix}ACCESS_KEY_ID`} is missing`,
		);
	}
}

/** Strips leading slashes and guarantees exactly one trailing slash. */
export function normalizePrefix(prefix: string): string {
	const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
	return trimmed ? `${trimmed}/` : DEFAULTS.s3Prefix;
}

/** Database name (URL path) of a Postgres connection URL. */
export function databaseName(databaseUrl: string): string {
	const url = parsePostgresUrl(databaseUrl);
	const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
	if (!name) throw new ConfigError('DATABASE_URL must include a database name');
	return name;
}

/** The same connection URL pointing at another database of the cluster. */
export function withDatabase(databaseUrl: string, database: string): string {
	const url = parsePostgresUrl(databaseUrl);
	url.pathname = `/${encodeURIComponent(database)}`;
	return url.toString();
}

/**
 * Splits a connection URL into what goes on a pg_dump/pg_restore command line and what goes in
 * its environment: argv is readable by every process on the host (`/proc/<pid>/cmdline`), so the
 * password travels as `PGPASSWORD` and the URL on argv carries none. libpq percent-decodes the
 * URL's password, so the env value is decoded to match.
 */
export function detachPassword(databaseUrl: string): { url: string; env: Record<string, string> } {
	const url = parsePostgresUrl(databaseUrl);
	const password = url.password;
	url.password = '';
	return { url: url.toString(), env: password ? { PGPASSWORD: decodeURIComponent(password) } : {} };
}

/** Connection URL with the password replaced, for logs and error messages. */
export function redactUrl(databaseUrl: string): string {
	try {
		const url = new URL(databaseUrl);
		if (url.password) url.password = '***';
		return url.toString();
	} catch {
		return '<invalid url>';
	}
}

function parsePostgresUrl(databaseUrl: string): URL {
	let url: URL;
	try {
		url = new URL(databaseUrl);
	} catch {
		throw new ConfigError('DATABASE_URL is not a valid URL');
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new ConfigError('DATABASE_URL must start with postgres:// or postgresql://');
	}
	return url;
}

function value(env: Env, name: string): string | undefined {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
}

function integer(env: Env, name: string, fallback: number): number {
	const raw = value(env, name);
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
	return Number(raw);
}

function duration(env: Env, name: string, fallback: string): number {
	const raw = value(env, name) ?? fallback;
	const parsed = parseDuration(raw);
	if (parsed === null) {
		throw new ConfigError(`${name} must be a duration such as 90s, 45m, 36h or 2d, got "${raw}"`);
	}
	return parsed;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
	const raw = value(env, name)?.toLowerCase();
	if (raw === undefined) return fallback;
	if (raw === 'true' || raw === '1') return true;
	if (raw === 'false' || raw === '0') return false;
	throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function isHttpUrl(candidate: string): boolean {
	try {
		const url = new URL(candidate);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
