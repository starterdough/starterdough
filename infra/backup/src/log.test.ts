import { describe, expect, it } from 'bun:test';
import { createLogger, errorMessage, type LogLevel } from './log';

describe('createLogger', () => {
	it('writes one JSON object per line with time, level, msg and the fields', () => {
		const lines: string[] = [];
		const log = createLogger((line) => lines.push(line));
		log.info('pg_dump finished', { file: 'starterdough_20260909T023000Z.dump', bytes: 42 });
		log.warn('heartbeat failed', { error: new Error('timeout'), skipped: undefined });

		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] as string);
		expect(Object.keys(first)).toEqual(['time', 'level', 'msg', 'file', 'bytes']);
		expect(first.level).toBe('info');
		expect(first.msg).toBe('pg_dump finished');
		expect(new Date(first.time).toISOString()).toBe(first.time);

		const second = JSON.parse(lines[1] as string);
		expect(second).toMatchObject({ level: 'warn', msg: 'heartbeat failed', error: 'timeout' });
		expect('skipped' in second).toBe(false);
	});

	it('hands the level to the writer, which is what keeps warn and error off stdout', () => {
		const written: Array<[LogLevel, string]> = [];
		const log = createLogger((line, level) => written.push([level, line]));
		log.info('a');
		log.warn('b');
		log.error('c');
		expect(written.map(([level]) => level)).toEqual(['info', 'warn', 'error']);
		expect(written[1]?.[1]).toContain('"msg":"b"');
	});

	it('flattens error causes into the message', () => {
		const error = new Error('restore failed', {
			cause: new Error('pg_restore exited with code 1'),
		});
		expect(errorMessage(error)).toBe('restore failed: pg_restore exited with code 1');
		expect(errorMessage('plain')).toBe('plain');
	});
});
