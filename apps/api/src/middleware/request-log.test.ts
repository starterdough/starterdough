import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { createLogger } from '../log';
import { requestLog } from './request-log';

function build() {
	const lines: Record<string, unknown>[] = [];
	const logger = createLogger({
		format: 'json',
		level: 'debug',
		sink: (_stream, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
	});
	const app = new Hono();
	app.use(requestId());
	// Behind a proxy, so the `x-forwarded-for` the tests send is the client address.
	app.use(requestLog({ logger, trustProxy: true }));
	app.get('/healthz', (c) => c.json({ status: 'ok' }));
	app.get('/readyz', (c) => c.json({ status: 'unavailable' }, 503));
	app.get('/things/:id', (c) => c.json({ id: c.req.param('id') }));
	// Stands in for anything logging from inside a request: an oRPC interceptor, a service call.
	app.get('/inside', (c) => {
		logger.warn('deep inside', { detail: 'no request id threaded here' });
		return c.json({ ok: true });
	});
	app.get('/boom', () => {
		throw new Error('kaput');
	});
	app.onError((_error, c) => c.json({ error: 'internal_error' }, 500));
	return { app, lines };
}

describe('requestLog', () => {
	it('logs method, path, status, duration, ip and request id for a request', async () => {
		const { app, lines } = build();
		const res = await app.request('/things/42?x=1', {
			headers: { 'x-forwarded-for': '203.0.113.7', 'x-request-id': 'req_abc' },
		});
		expect(res.status).toBe(200);

		expect(lines).toHaveLength(1);
		const line = lines[0] ?? {};
		expect(line).toMatchObject({
			level: 'info',
			msg: 'request',
			component: 'http',
			method: 'GET',
			path: '/things/42',
			status: 200,
			ip: '203.0.113.7',
			requestId: 'req_abc',
		});
		expect(typeof line.durationMs).toBe('number');
		expect(line.durationMs as number).toBeGreaterThanOrEqual(0);
	});

	it('uses the generated request id when the client sends none', async () => {
		const { app, lines } = build();
		const res = await app.request('/things/1');
		const id = res.headers.get('x-request-id');
		expect(id).toBeTruthy();
		expect(lines[0]?.requestId).toBe(id);
	});

	it('keeps successful health probes out of the log but reports failing ones', async () => {
		const { app, lines } = build();
		await app.request('/healthz');
		expect(lines).toHaveLength(0);

		await app.request('/readyz');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'error', path: '/readyz', status: 503 });
	});

	it('puts the request fields on every line written inside the request', async () => {
		const { app, lines } = build();
		await app.request('/inside', { headers: { 'x-request-id': 'req_inside' } });

		expect(lines.map((line) => line.msg)).toEqual(['deep inside', 'request']);
		expect(lines[0]).toMatchObject({
			msg: 'deep inside',
			requestId: 'req_inside',
			method: 'GET',
			path: '/inside',
			detail: 'no request id threaded here',
		});
	});

	it('leaves lines written outside a request alone', () => {
		const { lines } = build();
		createLogger({
			format: 'json',
			sink: (_stream, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		}).info('boot');
		expect(lines[0]).not.toHaveProperty('requestId');
	});

	it('raises the level with the status: 4xx warns, 5xx errors', async () => {
		const { app, lines } = build();
		await app.request('/missing');
		await app.request('/boom');
		expect(lines.map((l) => [l.level, l.status])).toEqual([
			['warn', 404],
			['error', 500],
		]);
	});
});
