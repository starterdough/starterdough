import { describe, expect, it } from 'bun:test';
import { createLogger, type LoggerOptions } from './log';

type Line = { stream: 'stdout' | 'stderr'; line: string };

function capture(options: Omit<LoggerOptions, 'sink'> = {}) {
	const lines: Line[] = [];
	const logger = createLogger({
		...options,
		sink: (stream, line) => lines.push({ stream, line }),
		now: () => new Date('2026-09-09T12:34:56.789Z'),
	});
	const json = () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>);
	return { logger, lines, json, first: () => only(lines), firstJson: () => only(json()) };
}

function only<T>(items: T[]): T {
	const [item] = items;
	if (item === undefined) throw new Error('expected at least one log line');
	return item;
}

describe('log', () => {
	it('writes one JSON object per line with time, level, msg and the fields', () => {
		const { logger, lines, json } = capture({ format: 'json', level: 'debug' });
		logger.info('request', { method: 'GET', path: '/healthz', status: 200, durationMs: 1.5 });
		logger.debug('poll');

		expect(lines).toHaveLength(2);
		for (const { line } of lines) expect(line).not.toContain('\n');
		expect(json()[0]).toEqual({
			time: '2026-09-09T12:34:56.789Z',
			level: 'info',
			msg: 'request',
			method: 'GET',
			path: '/healthz',
			status: 200,
			durationMs: 1.5,
		});
		expect(json()[1]).toEqual({ time: '2026-09-09T12:34:56.789Z', level: 'debug', msg: 'poll' });
	});

	it('sends info/debug to stdout and warn/error to stderr', () => {
		const { logger, lines } = capture({ format: 'json', level: 'debug' });
		logger.debug('a');
		logger.info('b');
		logger.warn('c');
		logger.error('d');
		expect(lines.map((l) => l.stream)).toEqual(['stdout', 'stdout', 'stderr', 'stderr']);
	});

	it('serialises Error values as name, message and stack (plus a cause when present)', () => {
		const { logger, firstJson } = capture({ format: 'json' });
		const cause = new RangeError('too deep');
		const error = new TypeError('bad input', { cause });
		logger.error('unhandled error', { error, requestId: 'req_1' });

		const line = firstJson();
		expect(line.level).toBe('error');
		expect(line.requestId).toBe('req_1');
		const serialised = line.error as {
			name: string;
			message: string;
			stack: string;
			cause: { name: string; message: string };
		};
		expect(serialised.name).toBe('TypeError');
		expect(serialised.message).toBe('bad input');
		expect(serialised.stack).toContain('TypeError: bad input');
		expect(serialised.cause).toMatchObject({ name: 'RangeError', message: 'too deep' });
	});

	it('does not add trace fields when no span is active', () => {
		const { logger, firstJson } = capture({ format: 'json' });
		logger.info('hello');
		const line = firstJson();
		expect(line).not.toHaveProperty('traceId');
		expect(line).not.toHaveProperty('spanId');
	});

	it('carries its own enumerable fields for custom errors', () => {
		class ServiceError extends Error {
			constructor(
				message: string,
				readonly status: number,
			) {
				super(message);
				this.name = 'ServiceError';
			}
		}
		const { logger, firstJson } = capture({ format: 'json' });
		logger.error('call failed', { error: new ServiceError('answered 502', 502) });
		expect(firstJson().error).toMatchObject({
			name: 'ServiceError',
			message: 'answered 502',
			status: 502,
		});
	});

	/**
	 * Drizzle wraps every driver failure in an error whose message is the SQL and whose own
	 * `query`/`params` hold the statement and every bound value — a failing session lookup used to
	 * log `select … where token = $1` next to the token itself.
	 */
	it('never writes a failed query, its parameters or a credential to the line', () => {
		class QueryError extends Error {
			constructor(
				readonly query: string,
				readonly params: unknown[],
				cause: Error,
			) {
				super(`Failed query: ${query}\nparams: ${params}`, { cause });
			}
		}
		const { logger, firstJson, lines } = capture({ format: 'json' });
		const error = new QueryError(
			'select * from "session" where "token" = $1',
			['a-live-session-token'],
			new Error('sorry, too many clients already'),
		);
		logger.error('procedure failed', { error, token: 'bearer-abc', headers: { cookie: 'sid=1' } });

		const line = firstJson();
		expect(line.token).toBe('[redacted]');
		expect(line.headers).toEqual({ cookie: '[redacted]' });
		expect(line.error).toMatchObject({
			// The envelope's message *is* the SQL, so it is replaced by the root cause the operator needs.
			message: 'sorry, too many clients already',
			query: '[redacted]',
			params: '[redacted]',
		});
		// Including the stack, whose first line is `<name>: <message>` — the SQL again.
		expect((line.error as { stack: string }).stack).toContain('sorry, too many clients already');
		const [written] = lines;
		expect(written?.line).not.toContain('from "session"');
		expect(written?.line).not.toContain('a-live-session-token');
		expect(written?.line).not.toContain('sid=1');
	});

	it('keeps a query error out of the pretty line and its stack too', () => {
		class QueryError extends Error {
			readonly query = 'select * from "session" where "token" = $1';
			readonly params = ['a-live-session-token'];
			constructor() {
				super('Failed query: select * from "session" where "token" = $1', {
					cause: new Error('connection terminated'),
				});
			}
		}
		const { logger, first } = capture({ format: 'pretty', color: false });
		logger.error('procedure failed', { error: new QueryError() });
		expect(first().line).not.toContain('from "session"');
		expect(first().line).not.toContain('a-live-session-token');
		expect(first().line).toContain('connection terminated');
	});

	it('redacts in pretty output too', () => {
		const { logger, first } = capture({ format: 'pretty', color: false });
		logger.error('query failed', { sql: 'select 1', requestId: 'req_1' });
		expect(first().line).toContain('sql=[redacted]');
		expect(first().line).toContain('requestId=req_1');
	});

	it('binds fields with `with` and lets call-site fields win', () => {
		const { logger, json } = capture({ format: 'json' });
		const jobs = logger.with({ component: 'jobs', attempt: 1 });
		jobs.info('claimed', { jobId: 'job_1' });
		jobs.with({ kind: 'text.embed' }).warn('failed', { attempt: 2 });

		expect(json()[0]).toMatchObject({ component: 'jobs', attempt: 1, jobId: 'job_1' });
		expect(json()[1]).toMatchObject({ component: 'jobs', kind: 'text.embed', attempt: 2 });
	});

	it('drops lines below the configured level', () => {
		const { logger, lines } = capture({ format: 'json', level: 'warn' });
		logger.debug('a');
		logger.info('b');
		logger.warn('c');
		expect(lines.map((l) => (JSON.parse(l.line) as { msg: string }).msg)).toEqual(['c']);
	});

	it('survives values JSON.stringify chokes on', () => {
		const { logger, firstJson } = capture({ format: 'json' });
		const cyclic: Record<string, unknown> = { name: 'loop' };
		cyclic.self = cyclic;
		const shared = { id: 'twice' };
		logger.info('odd values', { big: 10n, cyclic, pair: [shared, shared] });
		const line = firstJson();
		expect(line.big).toBe('10');
		expect(line.cyclic).toEqual({ name: 'loop', self: '[Circular]' });
		// A repeated reference is not a cycle: both copies survive.
		expect(line.pair).toEqual([{ id: 'twice' }, { id: 'twice' }]);
	});

	it('pretty-prints a single readable line, uncoloured when asked', () => {
		const { logger, first } = capture({ format: 'pretty', color: false });
		logger.info('request', { method: 'GET', path: '/api/v1/health', note: 'two words' });
		const { line } = first();
		expect(line).toMatch(
			/^\d{2}:\d{2}:\d{2} info {2}request method=GET path=\/api\/v1\/health note="two words"$/,
		);
		expect(line).not.toContain('\x1b[');
	});

	it('pretty-prints the stack of an error under the line', () => {
		const { logger, first } = capture({ format: 'pretty', color: false });
		logger.error('boom', { error: new Error('kaput') });
		const { line, stream } = first();
		expect(stream).toBe('stderr');
		const [head, ...rest] = line.split('\n');
		expect(head).toContain('error boom error="Error: kaput"');
		expect(rest.length).toBeGreaterThan(0);
		expect(rest[0]).toMatch(/^ {4}at /);
	});
});
