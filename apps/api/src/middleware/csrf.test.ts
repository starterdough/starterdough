import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { refuseCrossSiteCookieWrites } from './csrf';

const trusted = 'https://app.example.com';
const cookie = 'better-auth.session_token=abc.def';

/** A bare app with only the guard in front of a handler that says it was reached. */
function guarded() {
	const target = new Hono();
	target.use('/api/v1/*', refuseCrossSiteCookieWrites({ origins: [trusted] }));
	target.all('/api/v1/*', (c) => c.json({ reached: true }));
	return target;
}

function send(method: string, headers: Record<string, string>) {
	return guarded().request('/api/v1/admin/flags/csrf-probe', { method, headers });
}

describe('refuseCrossSiteCookieWrites', () => {
	it.each([
		['a cross-site page', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
		['a sibling subdomain', { origin: 'https://blog.example.com', 'sec-fetch-site': 'same-site' }],
		['an untrusted Origin from an older browser', { origin: 'https://evil.example' }],
		['an opaque origin (a sandboxed frame)', { origin: 'null' }],
		['an Origin that only shares a prefix', { origin: `${trusted}.evil.example` }],
		['a cross-site request whose Origin was stripped', { 'sec-fetch-site': 'cross-site' }],
	])('refuses a cookie-carrying POST from %s', async (_name, headers) => {
		const response = await send('POST', { ...headers, cookie });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'forbidden_origin' });
	});

	it.each(['PUT', 'PATCH', 'DELETE'])('refuses a forged %s the same way', async (method) => {
		const response = await send(method, { origin: 'https://evil.example', cookie });
		expect(response.status).toBe(403);
	});

	it.each([
		['the app on a sibling subdomain', { origin: trusted, 'sec-fetch-site': 'same-site' }],
		['a trusted page on another site', { origin: trusted, 'sec-fetch-site': 'cross-site' }],
		['the app on the same origin', { origin: trusted, 'sec-fetch-site': 'same-origin' }],
		['a server-side caller forwarding the cookie (SSR, scripts)', {}],
	])('lets through a cookie-carrying POST from %s', async (_name, headers) => {
		const response = await send('POST', { ...headers, cookie });
		expect(response.status).toBe(200);
	});

	it('leaves bearer and service-token callers alone, whatever page they run on', async () => {
		const response = await send('POST', {
			authorization: 'Bearer token-123',
			origin: 'https://evil.example',
			'sec-fetch-site': 'cross-site',
		});
		expect(response.status).toBe(200);
	});

	it('does not judge reads', async () => {
		for (const method of ['GET', 'HEAD']) {
			const response = await send(method, { origin: 'https://evil.example', cookie });
			expect(response.status).toBe(200);
		}
	});
});
