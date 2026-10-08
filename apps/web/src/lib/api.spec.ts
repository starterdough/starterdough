import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `#lib/api.js` reads the build target, whether it runs inside Tauri and `PUBLIC_WEB_URL` once, at
 * import, so every case imports a fresh copy with its own answers. `origin` is what
 * `location.origin` says there: the web app's own address in a browser, `tauri://localhost` or
 * `http://tauri.localhost` in a shell.
 */
async function build({
	bearer,
	tauri = false,
	webUrl,
	origin,
}: {
	bearer: boolean;
	tauri?: boolean;
	webUrl: string;
	origin: string;
}) {
	vi.resetModules();
	vi.doMock('./token-store', () => ({
		usesBearerAuth: bearer,
		tokenStore: { get: () => null, set: () => {}, clear: () => {} },
	}));
	vi.doMock('./pwa.svelte', () => ({ isTauri: tauri }));
	vi.doMock('$app/env/public', () => ({
		PUBLIC_API_URL: undefined,
		PUBLIC_DEMO_MODE: undefined,
		PUBLIC_WEB_URL: webUrl,
	}));
	vi.stubGlobal('location', { origin });
	return import('./api');
}

afterEach(() => {
	vi.doUnmock('./token-store');
	vi.doUnmock('./pwa.svelte');
	vi.doUnmock('$app/env/public');
	vi.unstubAllGlobals();
});

describe('a web build', () => {
	it('links back to its own origin and offers every sign-in method', async () => {
		const api = await build({ bearer: false, webUrl: '', origin: 'https://app.example.com' });

		expect(api.returnUrl('/verify-email')).toBe('https://app.example.com/verify-email');
		expect(api.RETURN_URLS_AVAILABLE).toBe(true);
		expect(api.SOCIAL_SIGN_IN_AVAILABLE).toBe(true);
		expect(api.PASSKEYS_AVAILABLE).toBe(true);
		expect(api.TWO_FACTOR_SIGN_IN_AVAILABLE).toBe(true);
		expect(api.IMPERSONATION_AVAILABLE).toBe(true);
	});
});

describe('a static build served to a browser', () => {
	it('keeps every sign-in method, because it runs on the web origin', async () => {
		const api = await build({
			bearer: true,
			webUrl: 'https://app.example.com',
			origin: 'https://app.example.com',
		});

		expect(api.returnUrl('/verify-email')).toBe('https://app.example.com/verify-email');
		expect(api.SOCIAL_SIGN_IN_AVAILABLE).toBe(true);
		expect(api.PASSKEYS_AVAILABLE).toBe(true);
		expect(api.TWO_FACTOR_SIGN_IN_AVAILABLE).toBe(true);
		expect(api.IMPERSONATION_AVAILABLE).toBe(true);
	});
});

describe('a static build on a static host without PUBLIC_WEB_URL', () => {
	it('uses its own origin as the return address, which a browser can open', async () => {
		const api = await build({ bearer: true, webUrl: '', origin: 'https://app.example.com' });

		expect(api.returnUrl('/app/settings')).toBe('https://app.example.com/app/settings');
		expect(api.RETURN_URLS_AVAILABLE).toBe(true);
	});
});

describe('a shell (static build inside Tauri)', () => {
	it('sends links that leave the device to PUBLIC_WEB_URL, never to its own origin', async () => {
		const api = await build({
			bearer: true,
			tauri: true,
			webUrl: 'https://app.example.com/',
			origin: 'http://tauri.localhost',
		});

		expect(api.returnUrl('/verify-email')).toBe('https://app.example.com/verify-email');
		expect(api.returnUrl('/app/settings')).toBe('https://app.example.com/app/settings');
		expect(api.returnUrl('/')).toBe('https://app.example.com/');
		expect(api.RETURN_URLS_AVAILABLE).toBe(true);
	});

	it('hides social sign-in, passkeys, the two-factor step and impersonation, return address or not', async () => {
		const api = await build({
			bearer: true,
			tauri: true,
			webUrl: 'https://app.example.com',
			origin: 'tauri://localhost',
		});

		// A provider round trip signs in the system browser, a passkey made for app.example.com
		// cannot be used from tauri://localhost, and neither the pending two-factor cookie nor the
		// admin's parked session comes back to a cross-site page: all four would be dead ends.
		expect(api.SOCIAL_SIGN_IN_AVAILABLE).toBe(false);
		expect(api.PASSKEYS_AVAILABLE).toBe(false);
		expect(api.TWO_FACTOR_SIGN_IN_AVAILABLE).toBe(false);
		expect(api.IMPERSONATION_AVAILABLE).toBe(false);
	});

	it('has no return address without PUBLIC_WEB_URL', async () => {
		const api = await build({
			bearer: true,
			tauri: true,
			webUrl: '',
			origin: 'http://tauri.localhost',
		});

		expect(api.RETURN_URLS_AVAILABLE).toBe(false);
	});
});

describe('outgoing URLs', () => {
	const src = fileURLToPath(new URL('..', import.meta.url));

	/**
	 * Every way a page can read its own address, which inside a shell is `tauri://localhost` or
	 * `http://tauri.localhost`: `location.origin` (also as `window.` or `document.`), the router's
	 * `page.url.origin` (also `$page.`), and `location.href` as the base of a `new URL()`. Assigning
	 * `location.href` navigates and builds nothing. The service worker's `sw.location.origin` only
	 * compares origins.
	 */
	const OWN_ADDRESS =
		/(?<!\bsw\.)\blocation\.origin\b|\bpage\.url\.origin\b|\blocation\.href\b(?!\s*=(?!=))/;

	it('are caught however a page reads its own address', () => {
		for (const line of [
			"callbackURL: location.origin + '/verify-email',",
			'const base = window.location.origin;',
			'redirectTo: page.url.origin + next,',
			"const link = $page.url.origin + '/app';",
			"const url = new URL('/reset-password', location.href);",
		]) {
			expect(line).toMatch(OWN_ADDRESS);
		}
		for (const line of [
			'if (url.origin !== sw.location.origin) return;',
			"location.href = '/login';",
			'if (url.href !== page.url.href) {',
			'callbackURL: returnUrl(next),',
		]) {
			expect(line).not.toMatch(OWN_ADDRESS);
		}
	});

	function* sources(dir: string): Generator<string> {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'paraglide') yield* sources(path);
			} else if (/\.(ts|svelte)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
				yield path;
			}
		}
	}

	it('are built by returnUrl(), never from the address of the page', () => {
		// `returnUrl()` is the one place allowed to read it; comment lines only describe it.
		const offenders: string[] = [];
		for (const path of sources(src)) {
			const file = relative(src, path);
			if (file === join('lib', 'api.ts')) continue;
			for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
				if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) continue;
				if (OWN_ADDRESS.test(line)) offenders.push(`${file}:${index + 1}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
