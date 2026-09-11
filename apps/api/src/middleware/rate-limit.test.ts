import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { clientIp, rateLimit } from './rate-limit';

// Behind a proxy, which is where `x-forwarded-for` is a client address rather than a claim.
function build(options: { max: number; windowMs: number; clock: { t: number } }) {
	const app = new Hono();
	app.use(
		'/limited/*',
		rateLimit({
			max: options.max,
			windowMs: options.windowMs,
			trustProxy: true,
			now: () => options.clock.t,
		}),
	);
	app.get('/limited/ping', (c) => c.text('pong'));
	app.get('/open', (c) => c.text('ok'));
	return app;
}

const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });

/** `app.request()` has no Bun socket behind it, so an untrusted header leaves `unknown`. */
async function ip(forwarded: string, trusted?: boolean): Promise<string> {
	const app = new Hono();
	app.get('/ip', (c) => c.text(trusted === undefined ? clientIp(c) : clientIp(c, trusted)));
	const res = await app.request('/ip', from(forwarded));
	return res.text();
}

describe('clientIp', () => {
	it('reads a single-hop x-forwarded-for only when a proxy is trusted', async () => {
		expect(await ip('203.0.113.7', true)).toBe('203.0.113.7');
		expect(await ip('203.0.113.7', false)).toBe('unknown');
	});

	it('ignores multi-hop chains even behind a trusted proxy', async () => {
		expect(await ip('203.0.113.7, 10.0.0.1', true)).toBe('unknown');
	});

	it('does not trust the header by default (TRUST_PROXY is unset here)', async () => {
		expect(await ip('203.0.113.7')).toBe('unknown');
	});
});

describe('rateLimit', () => {
	it('allows `max` requests per window, then answers 429 with Retry-After', async () => {
		const clock = { t: 1_000_000 };
		const app = build({ max: 3, windowMs: 60_000, clock });

		for (let i = 1; i <= 3; i++) {
			const res = await app.request('/limited/ping', from('203.0.113.1'));
			expect(res.status).toBe(200);
			expect(res.headers.get('RateLimit-Limit')).toBe('3');
			expect(res.headers.get('RateLimit-Remaining')).toBe(String(3 - i));
		}

		const blocked = await app.request('/limited/ping', from('203.0.113.1'));
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('Retry-After')).toBe('60');
		expect(blocked.headers.get('RateLimit-Remaining')).toBe('0');
		expect(await blocked.json()).toEqual({ error: 'rate_limited', retryAfter: 60 });
	});

	it('opens a fresh window once the previous one has elapsed', async () => {
		const clock = { t: 0 };
		const app = build({ max: 1, windowMs: 10_000, clock });

		expect((await app.request('/limited/ping', from('203.0.113.2'))).status).toBe(200);
		expect((await app.request('/limited/ping', from('203.0.113.2'))).status).toBe(429);

		clock.t += 10_000;
		expect((await app.request('/limited/ping', from('203.0.113.2'))).status).toBe(200);
	});

	it('keeps separate buckets per client IP', async () => {
		const clock = { t: 0 };
		const app = build({ max: 1, windowMs: 10_000, clock });

		expect((await app.request('/limited/ping', from('203.0.113.3'))).status).toBe(200);
		expect((await app.request('/limited/ping', from('203.0.113.4'))).status).toBe(200);
		expect((await app.request('/limited/ping', from('203.0.113.3'))).status).toBe(429);
	});

	it('does not trust multi-hop x-forwarded-for chains', async () => {
		const clock = { t: 0 };
		const app = build({ max: 1, windowMs: 10_000, clock });

		// Both chains fall back to the (absent) socket address → one shared bucket.
		expect((await app.request('/limited/ping', from('1.1.1.1, 10.0.0.1'))).status).toBe(200);
		expect((await app.request('/limited/ping', from('2.2.2.2, 10.0.0.1'))).status).toBe(429);
	});

	it('ignores a spoofed x-forwarded-for when no proxy is trusted', async () => {
		const app = new Hono();
		app.use('/limited/*', rateLimit({ max: 1, windowMs: 10_000, trustProxy: false }));
		app.get('/limited/ping', (c) => c.text('pong'));

		// Two "different clients" that only differ in the header they sent: one bucket.
		expect((await app.request('/limited/ping', from('203.0.113.8'))).status).toBe(200);
		expect((await app.request('/limited/ping', from('203.0.113.9'))).status).toBe(429);
	});

	it('leaves unmatched routes alone', async () => {
		const clock = { t: 0 };
		const app = build({ max: 1, windowMs: 10_000, clock });

		for (let i = 0; i < 5; i++) {
			const res = await app.request('/open', from('203.0.113.5'));
			expect(res.status).toBe(200);
			expect(res.headers.get('RateLimit-Limit')).toBeNull();
		}
	});
});
