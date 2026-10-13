import { describe, expect, it } from 'bun:test';
import { type Command, commandConfig, parseArgs, USAGE } from './cli';
import {
	configFromEnv,
	RELEASE_COMMAND_TIMEOUT_MS,
	RELEASE_LOCK_WAIT_MS,
	SCHEDULED_LOCK_WAIT_MS,
} from './config';

describe('parseArgs', () => {
	it('recognises the plain commands', () => {
		expect(parseArgs(['backup'])).toEqual({ ok: true, command: { command: 'backup' } });
		expect(parseArgs(['list'])).toEqual({ ok: true, command: { command: 'list' } });
		expect(parseArgs(['schedule'])).toEqual({ ok: true, command: { command: 'schedule' } });
		expect(parseArgs([])).toEqual({ ok: true, command: { command: 'help' } });
		expect(parseArgs(['--help'])).toEqual({ ok: true, command: { command: 'help' } });
	});

	it('parses restore with its flags in any order', () => {
		expect(parseArgs(['restore', 'latest'])).toEqual({
			ok: true,
			command: {
				command: 'restore',
				name: 'latest',
				database: undefined,
				drill: false,
				yes: false,
				uploads: false,
				noSafetyDump: false,
				forceDatabaseMismatch: false,
				noManifestCheck: false,
				noSingleTransaction: false,
				terminateConnections: false,
			},
		});
		expect(
			parseArgs([
				'restore',
				'latest',
				'--yes',
				'--force-database-mismatch',
				'--no-manifest-check',
				'--no-single-transaction',
				'--terminate-connections',
			]),
		).toMatchObject({
			ok: true,
			command: {
				forceDatabaseMismatch: true,
				noManifestCheck: true,
				noSingleTransaction: true,
				terminateConnections: true,
			},
		});
		expect(parseArgs(['restore', 'latest', '--yes', '--no-safety-dump'])).toMatchObject({
			ok: true,
			command: { yes: true, noSafetyDump: true },
		});
		expect(parseArgs(['restore', '--drill', '20260909T023000Z'])).toMatchObject({
			ok: true,
			command: { name: '20260909T023000Z', drill: true },
		});
		expect(
			parseArgs(['restore', 'latest', '--yes', '--uploads', '--database', 'starterdough_copy']),
		).toMatchObject({
			ok: true,
			command: { name: 'latest', yes: true, uploads: true, database: 'starterdough_copy' },
		});
		expect(parseArgs(['restore', 'latest', '--database=other'])).toMatchObject({
			ok: true,
			command: { database: 'other' },
		});
		expect(parseArgs(['restore', 'starterdough_20260909T023000Z.dump', '--drill'])).toMatchObject({
			ok: true,
			command: { name: 'starterdough_20260909T023000Z.dump', drill: true },
		});
	});

	it('parses the freshness check on list', () => {
		expect(parseArgs(['list'])).toEqual({ ok: true, command: { command: 'list' } });
		expect(parseArgs(['list', '--max-age', '12h'])).toEqual({
			ok: true,
			command: { command: 'list', maxAgeMs: 12 * 3_600_000 },
		});
		expect(parseArgs(['list', '--max-age=90m'])).toEqual({
			ok: true,
			command: { command: 'list', maxAgeMs: 90 * 60_000 },
		});
		// `null` is "do not check", which is not the same as the configured default.
		expect(parseArgs(['list', '--no-max-age'])).toEqual({
			ok: true,
			command: { command: 'list', maxAgeMs: null },
		});
		expect(parseArgs(['list', '--max-age', '36'])).toEqual({
			ok: false,
			error: '--max-age must be a duration such as 90s, 45m, 36h or 2d',
		});
		expect(parseArgs(['list', '--max-age'])).toEqual({
			ok: false,
			error: '--max-age needs a duration such as 36h',
		});
		expect(parseArgs(['list', 'now'])).toEqual({ ok: false, error: 'unexpected argument "now"' });
	});

	it('parses --release on backup, list and restore, and nowhere else', () => {
		expect(parseArgs(['backup', '--release'])).toEqual({
			ok: true,
			command: { command: 'backup', release: true },
		});
		expect(parseArgs(['list', '--release', '--max-age', '1h'])).toEqual({
			ok: true,
			command: { command: 'list', maxAgeMs: 3_600_000, release: true },
		});
		expect(parseArgs(['restore', 'latest', '--release', '--drill'])).toMatchObject({
			ok: true,
			command: { command: 'restore', name: 'latest', drill: true, release: true },
		});
		expect(parseArgs(['backup', '--release', '--release'])).toEqual({
			ok: false,
			error: 'backup takes no arguments but --release',
		});
		expect(parseArgs(['schedule', '--release'])).toEqual({
			ok: false,
			error: 'schedule takes no arguments',
		});
		expect(parseArgs(['list', '--release=yes'])).toEqual({
			ok: false,
			error: '--release takes no value',
		});
		expect(parseArgs(['restore', 'latest', '--release=1'])).toEqual({
			ok: false,
			error: '--release takes no value',
		});
		// A release set holds the database only, so there is no uploads archive to install.
		expect(parseArgs(['restore', 'latest', '--release', '--yes', '--uploads'])).toEqual({
			ok: false,
			error: '--uploads cannot be used with --release: release sets hold the database only',
		});
	});

	it('rejects unknown commands, unknown options and missing values', () => {
		expect(parseArgs(['dump'])).toEqual({ ok: false, error: 'unknown command "dump"' });
		expect(parseArgs(['backup', 'now'])).toEqual({
			ok: false,
			error: 'backup takes no arguments but --release',
		});
		expect(parseArgs(['restore'])).toEqual({
			ok: false,
			error: 'restore needs a backup name or "latest"',
		});
		expect(parseArgs(['restore', 'latest', '--force'])).toEqual({
			ok: false,
			error: 'unknown option "--force"',
		});
		expect(parseArgs(['restore', 'latest', '--database'])).toEqual({
			ok: false,
			error: '--database needs a database name',
		});
		expect(parseArgs(['restore', 'latest', '--database', '--yes'])).toEqual({
			ok: false,
			error: '--database needs a database name',
		});
		expect(parseArgs(['restore', 'latest', '--drill=1'])).toEqual({
			ok: false,
			error: '--drill takes no value',
		});
		expect(parseArgs(['restore', 'a', 'b'])).toEqual({
			ok: false,
			error: 'unexpected argument "b"',
		});
	});

	it('documents every command in the usage text', () => {
		for (const word of [
			'backup',
			'restore',
			'list',
			'schedule',
			'--drill',
			'--yes',
			'--uploads',
			'--no-safety-dump',
			'--force-database-mismatch',
			'--no-manifest-check',
			'--no-single-transaction',
			'--terminate-connections',
			'--max-age',
			'--no-max-age',
			'--release',
			'BACKUP_ON_START',
			'BACKUP_CATCHUP',
			'BACKUP_MAX_AGE',
		]) {
			expect(USAGE).toContain(word);
		}
	});
});

describe('commandConfig', () => {
	const config = configFromEnv({
		DATABASE_URL: 'postgres://starterdough@postgres:5432/starterdough',
		BACKUP_DIR: '/backups',
	});
	const parsed = (argv: string[]): Command => {
		const result = parseArgs(argv);
		if (!result.ok) throw new Error(result.error);
		return result.command;
	};

	it('lets the scheduler wait for the lock and a manual backup refuse at once', () => {
		expect(commandConfig(parsed(['schedule']), config).lockWaitMs).toBe(SCHEDULED_LOCK_WAIT_MS);
		expect(commandConfig(parsed(['backup']), config)).toBe(config);
		expect(commandConfig(parsed(['restore', 'latest', '--yes']), config)).toBe(config);
	});

	it('points every --release command at the release sets', () => {
		const backup = commandConfig(parsed(['backup', '--release']), config);
		expect(backup).toMatchObject({
			backupDir: '/backups/release',
			s3: null,
			lockWaitMs: RELEASE_LOCK_WAIT_MS,
			commandTimeoutMs: RELEASE_COMMAND_TIMEOUT_MS,
		});
		expect(commandConfig(parsed(['list', '--release']), config).backupDir).toBe('/backups/release');
		// A deploy waits on the dump, so it has a ceiling of its own. Nobody waits on a restore.
		const restore = commandConfig(parsed(['restore', 'latest', '--release', '--yes']), config);
		expect(restore.backupDir).toBe('/backups/release');
		expect(restore.commandTimeoutMs).toBe(config.commandTimeoutMs);
	});
});
