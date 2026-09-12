import { describe, expect, it } from 'bun:test';
import { CLIENT_IP_HEADER } from '@repo/auth/server';
import { app, singleFlight, withClientIp } from './app';

describe('api', () => {
	it('answers the liveness probe', async () => {
		const res = await app.request('/healthz');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});

	it('answers the readiness probe with the outcome of the database check', async () => {
		// Tests run without a database, so the honest answer here is usually 503. What matters is
		// that the probe answers promptly, in the documented shape, and never throws.
		const started = performance.now();
		const res = await app.request('/readyz');
		expect(performance.now() - started).toBeLessThan(2_500);
		expect([200, 503]).toContain(res.status);
		const body = (await res.json()) as { status: string; checks: { database: string } };
		if (res.status === 200) {
			expect(body).toEqual({ status: 'ok', checks: { database: 'ok' } });
		} else {
			// A coarse token, never what Postgres said: the probe is public (see `/readyz` in app.ts).
			expect(body.status).toBe('unavailable');
			expect(['timeout', 'unreachable']).toContain(body.checks.database);
		}
	});

	it('answers a burst of readiness probes with one verdict', async () => {
		const bodies = await Promise.all(
			Array.from({ length: 5 }, async () => (await app.request('/readyz')).text()),
		);
		expect(new Set(bodies).size).toBe(1);
	});

	// What keeps a hung Postgres from costing the pool a connection per `/readyz` poll.
	it('shares one in-flight call between concurrent callers, then starts a new one', async () => {
		let calls = 0;
		let release = () => {};
		const shared = singleFlight(() => {
			calls++;
			return new Promise<string>((resolve) => {
				release = () => resolve('done');
			});
		});

		const waiting = [shared(), shared(), shared()];
		expect(calls).toBe(1);
		release();
		expect(await Promise.all(waiting)).toEqual(['done', 'done', 'done']);

		// The call is over, so the next caller starts a fresh one instead of a stale answer.
		const next = shared();
		expect(calls).toBe(2);
		release();
		expect(await next).toBe('done');
	});

	it('tags every response with a request id and keeps a well-formed incoming one', async () => {
		const fresh = await app.request('/healthz');
		expect(fresh.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

		const forwarded = await app.request('/healthz', { headers: { 'x-request-id': 'caddy-42' } });
		expect(forwarded.headers.get('x-request-id')).toBe('caddy-42');

		const hostile = await app.request('/healthz', { headers: { 'x-request-id': 'a b<c>' } });
		expect(hostile.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('sets the security headers and only opens CORS to trusted origins', async () => {
		const foreign = await app.request('/healthz', { headers: { origin: 'https://evil.example' } });
		expect(foreign.headers.get('x-content-type-options')).toBe('nosniff');
		// Cross-origin on purpose: the app on `app.` embeds what the API on `api.` serves.
		expect(foreign.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
		expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

		const trusted = await app.request('/healthz', { headers: { origin: 'http://localhost:5173' } });
		expect(trusted.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
	});

	it('locks browsers out of everything on the API origin and lets no answer be cached', async () => {
		const res = await app.request('/api/v1/health');
		expect(res.headers.get('content-security-policy')).toBe(
			"default-src 'none'; frame-ancestors 'none'",
		);
		expect(res.headers.get('cache-control')).toBe('private, no-store');

		// The probes are the exception: machines poll them and they carry no tenant data.
		expect((await app.request('/healthz')).headers.get('cache-control')).toBeNull();
	});

	it('refuses an oversized procedure body before it reaches a handler', async () => {
		const res = await app.request('/api/v1/contact', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024) },
			body: JSON.stringify({ email: 'v@example.com', message: 'x'.repeat(2 * 1024 * 1024) }),
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: 'payload_too_large', maxBytes: 1024 * 1024 });
	});

	// A caller that could set this header would choose its own rate-limit bucket in Better Auth and
	// the address recorded on its session.
	it('overwrites a client-supplied forwarded-ip header on the auth routes', () => {
		const forged = new Request('http://api.test/api/auth/sign-in/email', {
			headers: { [CLIENT_IP_HEADER]: '9.9.9.9' },
		});
		expect(withClientIp(forged, '203.0.113.7').headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
	});

	it('serves the health procedure over REST', async () => {
		const res = await app.request('/api/v1/health');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; version: string };
		expect(body.status).toBe('ok');
	});

	it('serves the health procedure over RPC', async () => {
		const res = await app.request('/rpc/system/health', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ json: undefined }),
		});
		expect(res.status).toBe(200);
	});

	it('tells clients which sign-in methods are configured', async () => {
		const res = await app.request('/api/v1/auth-config');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			socialProviders: string[];
			requireEmailVerification: boolean;
		};
		// No GITHUB_/GOOGLE_ credentials in the test env → nothing advertised.
		expect(body.socialProviders).toEqual([]);
		expect(typeof body.requireEmailVerification).toBe('boolean');
	});

	it('publishes an OpenAPI 3.1 document derived from the contract', async () => {
		const res = await app.request('/api/v1/openapi.json');
		expect(res.status).toBe(200);
		const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
		expect(spec.openapi.startsWith('3.1')).toBe(true);
		expect(Object.keys(spec.paths)).toEqual(
			expect.arrayContaining([
				'/health',
				'/auth-config',
				'/contact',
				'/me',
				'/flags',
				'/admin/flags',
				'/admin/flags/{key}',
				'/admin/system',
			]),
		);
	});

	describe('contact form', () => {
		const post = (body: unknown) =>
			app.request('/api/v1/contact', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});

		it('validates the message and reports the fields', async () => {
			const res = await post({ email: 'not-an-email', message: 'short' });
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				code: string;
				data: { issues: { path: string[] }[] };
			};
			expect(body.code).toBe('BAD_REQUEST');
			expect(body.data.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
				'email',
				'message',
			]);
		});

		it('delivers a valid message (console provider in tests) and swallows honeypot hits', async () => {
			const ok = await post({
				email: 'visitor@example.com',
				name: 'Visitor',
				message: 'Hello from the contact form test.',
			});
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({ ok: true });

			const bot = await post({
				email: 'bot@example.com',
				message: 'Buy cheap things at my website now.',
				website: 'https://spam.example',
			});
			expect(bot.status).toBe(200);
			expect(await bot.json()).toEqual({ ok: true });
		});

		it('is throttled per client well below the general limiter', async () => {
			let limited: Response | null = null;
			for (let i = 0; i < 6 && !limited; i++) {
				const res = await post({ email: 'v@example.com', message: `Another message, number ${i}` });
				if (res.status === 429) limited = res;
			}
			expect(limited?.status).toBe(429);
			expect(limited?.headers.get('retry-after')).toBeTruthy();
		});
	});

	it('refuses anonymous callers on every admin procedure', async () => {
		for (const path of ['/api/v1/admin/system', '/api/v1/admin/flags']) {
			const res = await app.request(path);
			expect(res.status).toBe(401);
		}
	});

	it('exposes Better Auth under /api/auth', async () => {
		// Also fails loudly if the generated Drizzle schema drifts from the auth config.
		const res = await app.request('/api/auth/ok');
		expect(res.status).toBe(200);
	});
});
