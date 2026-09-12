import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BackupConfig, configFromEnv } from './config';
import { listBackups } from './list';
import { createLogger, type LogLevel } from './log';
import { createManifest, dumpName, manifestName, uploadsName } from './names';

const tmp = await mkdtemp(join(tmpdir(), 'starterdough-backup-list-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

const NOW = new Date('2026-09-10T06:00:00Z');

async function writeSet(dir: string, stamp: string, options: { manifest?: boolean } = {}) {
	await Bun.write(join(dir, dumpName(stamp)), 'dump');
	if (options.manifest === false) return;
	const manifest = createManifest({
		stamp,
		database: 'starterdough',
		pgDumpVersion: '17.6',
		files: [{ name: dumpName(stamp), bytes: 4, sha256: 'x'.repeat(64) }],
		tableEntries: 3,
		rowCounts: { user: 2, organization: 1 },
		uploadsDegraded: null,
		warnings: [],
	});
	await Bun.write(join(dir, manifestName(stamp)), JSON.stringify(manifest));
}

async function listIn(dir: string, maxAgeMs?: number) {
	const lines: { level: LogLevel; line: string }[] = [];
	const log = createLogger((line, level) => lines.push({ level, line }));
	const config: BackupConfig = {
		...configFromEnv({ DATABASE_URL: 'postgres://d:s@postgres:5432/starterdough' }),
		backupDir: dir,
		...(maxAgeMs === undefined ? {} : { maxAgeMs }),
	};
	return { result: await listBackups(config, log, null, NOW), lines };
}

describe('list --max-age', () => {
	it('is fresh when the newest set is inside the limit', async () => {
		const dir = await mkdtemp(join(tmp, 'fresh-'));
		await writeSet(dir, '20260908T023000Z');
		await writeSet(dir, '20260910T023000Z');
		const { result } = await listIn(dir);
		expect(result.sets.map((set) => set.stamp)).toEqual(['20260910T023000Z', '20260908T023000Z']);
		expect(result.newestAgeMs).toBe(3.5 * 3_600_000);
		expect(result.fresh).toBe(true);
	});

	it('is stale — and says so at error level — when the newest set is past the limit', async () => {
		const dir = await mkdtemp(join(tmp, 'stale-'));
		await writeSet(dir, '20260901T023000Z');
		const { result, lines } = await listIn(dir);
		expect(result.fresh).toBe(false);
		expect(result.newestAgeMs).toBe(9 * 86_400_000 + 3.5 * 3_600_000);
		// The whole point: a monitor learns from the exit code, a human from this line.
		expect(
			lines.some(
				(entry) => entry.level === 'error' && entry.line.includes('9d old, past the 36h limit'),
			),
		).toBe(true);
	});

	it('is stale when there is no restorable set at all', async () => {
		const dir = await mkdtemp(join(tmp, 'empty-'));
		const { result, lines } = await listIn(dir);
		expect(result.sets).toEqual([]);
		expect(result.newestAgeMs).toBeNull();
		expect(result.fresh).toBe(false);
		expect(
			lines.some((entry) => entry.level === 'error' && entry.line.includes('no restorable backup')),
		).toBe(true);
		// A manifest without its dump is not a backup either.
		await Bun.write(join(dir, manifestName('20260910T023000Z')), '{}');
		expect((await listIn(dir)).result.fresh).toBe(false);
	});

	it('an infinite limit lists without judging', async () => {
		const dir = await mkdtemp(join(tmp, 'nocheck-'));
		await writeSet(dir, '20200101T023000Z');
		const { result } = await listIn(dir, Number.POSITIVE_INFINITY);
		expect(result.sets).toHaveLength(1);
		expect(result.fresh).toBe(true);
	});

	it('never counts a future-dated set as evidence that a backup happened', async () => {
		const dir = await mkdtemp(join(tmp, 'future-'));
		await writeSet(dir, '20260901T023000Z');
		await writeSet(dir, '20270101T023000Z');
		const { result, lines } = await listIn(dir);
		expect(result.sets).toHaveLength(2);
		expect(result.fresh).toBe(false);
		expect(lines.some((entry) => entry.line.includes('dated in the future'))).toBe(true);
	});

	it('surfaces the pre-restore dumps nothing prunes, with their sizes', async () => {
		const dir = await mkdtemp(join(tmp, 'safety-'));
		await writeSet(dir, '20260910T023000Z');
		await Bun.write(join(dir, uploadsName('20260910T023000Z')), 'tar');
		await Bun.write(join(dir, 'starterdough_20260910T030000Z_pre_restore.dump'), 'x'.repeat(1024));
		const { result, lines } = await listIn(dir);
		expect(result.safetyDumps).toEqual([
			{
				name: 'starterdough_20260910T030000Z_pre_restore.dump',
				bytes: 1024,
				modified: expect.any(String),
			},
		]);
		// Not one of the artifact kinds, so it is never listed as part of a set.
		expect(result.sets[0]?.local.sort()).toEqual(['dump', 'manifest', 'uploads']);
		expect(lines.some((entry) => entry.line.includes('pre-restore dump starterdough_'))).toBe(true);
	});
});
