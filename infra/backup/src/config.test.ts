import { describe, expect, it } from 'bun:test';
import {
	ConfigError,
	configFromEnv,
	databaseName,
	detachPassword,
	normalizePrefix,
	parseDuration,
	redactUrl,
	withDatabase,
} from './config';

const DATABASE_URL = 'postgres://starterdough:secret@postgres:5432/starterdough';

describe('configFromEnv', () => {
	it('requires DATABASE_URL and applies the documented defaults', () => {
		expect(() => configFromEnv({})).toThrow(ConfigError);
		expect(() => configFromEnv({ DATABASE_URL: '' })).toThrow('DATABASE_URL is required');

		const config = configFromEnv({ DATABASE_URL });
		expect(config.database).toBe('starterdough');
		expect(config.backupDir).toBe('./backups');
		expect(config.retentionDays).toBe(14);
		expect(config.schedule).toBe('30 2 * * *');
		expect(config.s3).toBeNull();
		expect(config.heartbeatUrl).toBeUndefined();
		expect(config.uploads).toEqual({ kind: 'none' });
		expect(config.runOnStart).toBe(false);
		// Catch-up is on by default: Bun.cron has none of its own, so a reboot past the schedule would
		// otherwise skip the night in silence.
		expect(config.catchUp).toBe(true);
		expect(config.maxAgeMs).toBe(36 * 3_600_000);
		expect(config.commandTimeoutMs).toBe(6 * 3_600_000);
		expect(config.lockTimeoutMs).toBe(60_000);
		expect(config.warnings).toHaveLength(2);
		// A backup nobody is told about when it stops is the failure mode the first one warns about.
		expect(config.warnings[0]).toContain('BACKUP_HEARTBEAT_URL');
		expect(config.warnings[1]).toContain('stay on this machine');
	});

	it('reads the freshness, catch-up and timeout settings', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_CATCHUP: 'false',
			BACKUP_MAX_AGE: '2d',
			BACKUP_COMMAND_TIMEOUT_MINUTES: '30',
			BACKUP_LOCK_TIMEOUT: '90s',
		});
		expect(config.catchUp).toBe(false);
		expect(config.maxAgeMs).toBe(2 * 86_400_000);
		expect(config.commandTimeoutMs).toBe(30 * 60_000);
		expect(config.lockTimeoutMs).toBe(90_000);
	});

	it('parses durations with a unit and refuses a bare number', () => {
		expect(parseDuration('90s')).toBe(90_000);
		expect(parseDuration('45m')).toBe(45 * 60_000);
		expect(parseDuration('36h')).toBe(36 * 3_600_000);
		expect(parseDuration(' 2d ')).toBe(2 * 86_400_000);
		// Seconds to lock_timeout, days to retention: the same string cannot mean both.
		expect(parseDuration('36')).toBeNull();
		expect(parseDuration('1w')).toBeNull();
		expect(parseDuration('-1h')).toBeNull();
		expect(parseDuration('')).toBeNull();
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_MAX_AGE: '36' })).toThrow(
			'BACKUP_MAX_AGE must be a duration such as 90s, 45m, 36h or 2d, got "36"',
		);
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_COMMAND_TIMEOUT_MINUTES: '0' })).toThrow(
			'BACKUP_COMMAND_TIMEOUT_MINUTES must be a positive integer',
		);
	});

	it('reads BACKUP_ON_START and rejects anything that is not a boolean', () => {
		expect(configFromEnv({ DATABASE_URL, BACKUP_ON_START: 'true' }).runOnStart).toBe(true);
		expect(configFromEnv({ DATABASE_URL, BACKUP_ON_START: '1' }).runOnStart).toBe(true);
		expect(configFromEnv({ DATABASE_URL, BACKUP_ON_START: 'False' }).runOnStart).toBe(false);
		expect(configFromEnv({ DATABASE_URL, BACKUP_ON_START: '' }).runOnStart).toBe(false);
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_ON_START: 'yes' })).toThrow(
			'BACKUP_ON_START must be true or false',
		);
	});

	it('reads the explicit variables', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_DIR: '/backups',
			BACKUP_RETENTION_DAYS: '30',
			BACKUP_SCHEDULE: '0 4 * * *',
			BACKUP_HEARTBEAT_URL: 'https://hc-ping.com/abc',
			STORAGE_DIR: '/data/uploads',
		});
		expect(config.backupDir).toBe('/backups');
		expect(config.retentionDays).toBe(30);
		expect(config.schedule).toBe('0 4 * * *');
		expect(config.heartbeatUrl).toBe('https://hc-ping.com/abc');
		expect(config.uploads).toEqual({ kind: 'directory', dir: '/data/uploads' });
	});

	it('uses the dedicated BACKUP_S3_* bucket when set', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_S3_BUCKET: 'starterdough-backups',
			BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
			BACKUP_S3_REGION: 'auto',
			BACKUP_S3_ACCESS_KEY_ID: 'backup-key',
			BACKUP_S3_SECRET_ACCESS_KEY: 'backup-secret',
			BACKUP_S3_PREFIX: 'nightly',
			S3_BUCKET: 'starterdough-uploads',
			S3_ACCESS_KEY_ID: 'uploads-key',
			S3_SECRET_ACCESS_KEY: 'uploads-secret',
		});
		expect(config.s3).toEqual({
			bucket: 'starterdough-backups',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			region: 'auto',
			accessKeyId: 'backup-key',
			secretAccessKey: 'backup-secret',
			prefix: 'nightly/',
			source: 'backup',
		});
		// S3_BUCKET is set too, so the documents are in a bucket this tool does not archive.
		expect(config.warnings).toHaveLength(2);
		expect(config.warnings[0]).toContain('BACKUP_HEARTBEAT_URL');
		expect(config.warnings[1]).toContain('versioning');
	});

	it('falls back to the uploads bucket (S3_*) under BACKUP_S3_PREFIX', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_S3_BUCKET: '',
			S3_BUCKET: 'starterdough-uploads',
			S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
			S3_REGION: 'auto',
			S3_ACCESS_KEY_ID: 'uploads-key',
			S3_SECRET_ACCESS_KEY: 'uploads-secret',
			STORAGE_DIR: '/data/uploads',
		});
		expect(config.s3).toEqual({
			bucket: 'starterdough-uploads',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			region: 'auto',
			accessKeyId: 'uploads-key',
			secretAccessKey: 'uploads-secret',
			prefix: 'backups/',
			source: 'uploads',
		});
		// Documents already live in the bucket, so the directory is not archived even though it is set.
		expect(config.uploads).toEqual({ kind: 's3' });
		expect(config.warnings).toHaveLength(2);
		expect(config.warnings[1]).toContain('versioning');
	});

	it('rejects a half-configured credential pair on either prefix', () => {
		const base = {
			DATABASE_URL,
			BACKUP_S3_BUCKET: 'starterdough-backups',
			BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
		};
		expect(() => configFromEnv({ ...base, BACKUP_S3_ACCESS_KEY_ID: 'key' })).toThrow(
			'BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY must be set together; BACKUP_S3_SECRET_ACCESS_KEY is missing',
		);
		expect(() => configFromEnv({ ...base, BACKUP_S3_SECRET_ACCESS_KEY: 'secret' })).toThrow(
			'BACKUP_S3_ACCESS_KEY_ID is missing',
		);
		expect(() => configFromEnv({ ...base, S3_SECRET_ACCESS_KEY: 'secret' })).toThrow(
			'S3_ACCESS_KEY_ID is missing',
		);
		// Both halves of one prefix, or neither, is what a signed request needs.
		expect(
			configFromEnv({ ...base, BACKUP_S3_ACCESS_KEY_ID: 'key', BACKUP_S3_SECRET_ACCESS_KEY: 's' })
				.s3,
		).toMatchObject({ accessKeyId: 'key', secretAccessKey: 's' });
		expect(configFromEnv({ ...base }).s3).toMatchObject({
			accessKeyId: undefined,
			secretAccessKey: undefined,
		});
	});

	it('accepts region "auto" only with an explicit endpoint', () => {
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_S3_BUCKET: 'starterdough-backups' })).toThrow(
			ConfigError,
		);
		expect(() =>
			configFromEnv({ DATABASE_URL, BACKUP_S3_BUCKET: 'b', BACKUP_S3_REGION: 'auto' }),
		).toThrow('needs an explicit BACKUP_S3_ENDPOINT');
		expect(
			configFromEnv({ DATABASE_URL, BACKUP_S3_BUCKET: 'b', BACKUP_S3_REGION: 'us-east-1' }).s3,
		).toMatchObject({ region: 'us-east-1', endpoint: undefined });
		expect(
			configFromEnv({
				DATABASE_URL,
				BACKUP_S3_BUCKET: 'b',
				BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
			}).s3,
		).toMatchObject({ region: 'auto' });
		// No bucket at all: the region is nobody's business.
		expect(configFromEnv({ DATABASE_URL, BACKUP_S3_REGION: 'auto' }).s3).toBeNull();
	});

	it('fills blank BACKUP_S3_* values from their S3_* twins', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_S3_BUCKET: 'starterdough-backups',
			S3_BUCKET: 'starterdough-uploads',
			S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
			S3_REGION: 'weur',
			S3_ACCESS_KEY_ID: 'shared-key',
			S3_SECRET_ACCESS_KEY: 'shared-secret',
		});
		expect(config.s3).toMatchObject({
			bucket: 'starterdough-backups',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			region: 'weur',
			accessKeyId: 'shared-key',
			secretAccessKey: 'shared-secret',
			source: 'backup',
		});
	});

	it('treats blank strings as unset, the way .env files leave them', () => {
		const config = configFromEnv({
			DATABASE_URL,
			BACKUP_DIR: '',
			BACKUP_RETENTION_DAYS: ' ',
			BACKUP_SCHEDULE: '',
			BACKUP_S3_BUCKET: '',
			S3_BUCKET: '',
			BACKUP_HEARTBEAT_URL: '',
			STORAGE_DIR: '',
		});
		expect(config.backupDir).toBe('./backups');
		expect(config.retentionDays).toBe(14);
		expect(config.schedule).toBe('30 2 * * *');
		expect(config.s3).toBeNull();
		expect(config.heartbeatUrl).toBeUndefined();
		expect(config.uploads).toEqual({ kind: 'none' });
	});

	it('rejects malformed values instead of guessing', () => {
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_RETENTION_DAYS: 'two' })).toThrow(
			'BACKUP_RETENTION_DAYS must be an integer',
		);
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_RETENTION_DAYS: '0' })).toThrow(
			'positive integer',
		);
		expect(() => configFromEnv({ DATABASE_URL, BACKUP_HEARTBEAT_URL: 'hc-ping.com/abc' })).toThrow(
			'BACKUP_HEARTBEAT_URL must be an http(s) URL',
		);
		expect(() => configFromEnv({ DATABASE_URL: 'mysql://x/y' })).toThrow('postgres://');
		expect(() => configFromEnv({ DATABASE_URL: 'postgres://starterdough@localhost:5432' })).toThrow(
			'database name',
		);
		expect(() => configFromEnv({ DATABASE_URL: 'not a url' })).toThrow('not a valid URL');
	});
});

describe('URL helpers', () => {
	it('extracts and swaps the database name while keeping the rest of the URL', () => {
		const url = 'postgresql://starterdough:s3cret@db.internal:5433/starterdough?sslmode=require';
		expect(databaseName(url)).toBe('starterdough');
		expect(withDatabase(url, 'postgres')).toBe(
			'postgresql://starterdough:s3cret@db.internal:5433/postgres?sslmode=require',
		);
		expect(withDatabase(url, 'starterdough_drill_20260909t023000z')).toContain(
			'/starterdough_drill_20260909t023000z?sslmode=require',
		);
	});

	it('redacts the password for logs', () => {
		expect(redactUrl(DATABASE_URL)).toBe('postgres://starterdough:***@postgres:5432/starterdough');
		expect(redactUrl('postgres://postgres:5432/starterdough')).toBe(
			'postgres://postgres:5432/starterdough',
		);
		expect(redactUrl('nope')).toBe('<invalid url>');
	});

	it('moves the password off argv into PGPASSWORD, decoded the way libpq reads it', () => {
		expect(detachPassword(DATABASE_URL)).toEqual({
			url: 'postgres://starterdough@postgres:5432/starterdough',
			env: { PGPASSWORD: 'secret' },
		});
		expect(
			detachPassword('postgres://starterdough:p%40ss%2Fword@postgres:5432/starterdough'),
		).toEqual({
			url: 'postgres://starterdough@postgres:5432/starterdough',
			env: { PGPASSWORD: 'p@ss/word' },
		});
		expect(detachPassword('postgres://postgres:5432/starterdough?sslmode=require')).toEqual({
			url: 'postgres://postgres:5432/starterdough?sslmode=require',
			env: {},
		});
	});

	it('normalises the key prefix to a single trailing slash', () => {
		expect(normalizePrefix('backups')).toBe('backups/');
		expect(normalizePrefix('/nightly//')).toBe('nightly/');
		expect(normalizePrefix('a/b/')).toBe('a/b/');
		expect(normalizePrefix('/')).toBe('backups/');
	});
});
