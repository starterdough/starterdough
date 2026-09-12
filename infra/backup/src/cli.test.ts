import { describe, expect, it } from 'bun:test';
import { parseArgs, USAGE } from './cli';

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

	it('rejects unknown commands, unknown options and missing values', () => {
		expect(parseArgs(['dump'])).toEqual({ ok: false, error: 'unknown command "dump"' });
		expect(parseArgs(['backup', 'now'])).toEqual({ ok: false, error: 'backup takes no arguments' });
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
			'BACKUP_ON_START',
			'BACKUP_CATCHUP',
			'BACKUP_MAX_AGE',
		]) {
			expect(USAGE).toContain(word);
		}
	});
});
