import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, run, writeViaPartFile } from './proc';

const tmp = await mkdtemp(join(tmpdir(), 'starterdough-backup-proc-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('writeViaPartFile', () => {
	it('renames the finished part file into place and returns the producer result', async () => {
		const path = join(tmp, 'starterdough_20260909T023000Z.dump');
		const result = await writeViaPartFile(path, async (part) => {
			expect(part).toBe(`${path}.part`);
			await Bun.write(part, 'dump');
			return 42;
		});
		expect(result).toBe(42);
		expect(await Bun.file(path).text()).toBe('dump');
		expect(await readdir(tmp)).toEqual(['starterdough_20260909T023000Z.dump']);
	});

	it('kills a command that outlives its timeout and says so', async () => {
		// Bun's spawn has no default timeout: without one a pg_dump waiting on a lock keeps the
		// scheduler's overlap guard closed and every later tick is skipped with "still running".
		const result = await run([process.execPath, '-e', 'await Bun.sleep(30_000)'], {
			timeoutMs: 300,
		});
		expect(result.killed).toBe(true);
		expect(result.code).not.toBe(0);
		expect(result.durationMs).toBeLessThan(10_000);
		expect(new CommandError('pg_dump', result).message).toContain(
			'was killed after its 300 ms timeout',
		);

		const quick = await run([process.execPath, '-e', 'console.log("done")'], { timeoutMs: 30_000 });
		expect(quick).toMatchObject({ code: 0, killed: false });
		expect(quick.stdout.trim()).toBe('done');
	});

	it('leaves nothing behind when the producer fails', async () => {
		const path = join(tmp, 'starterdough_20260910T023000Z.dump');
		await expect(
			writeViaPartFile(path, async (part) => {
				await Bun.write(part, 'trunc');
				throw new Error('connection reset');
			}),
		).rejects.toThrow('connection reset');
		expect(await readdir(tmp)).toEqual(['starterdough_20260909T023000Z.dump']);
	});
});
