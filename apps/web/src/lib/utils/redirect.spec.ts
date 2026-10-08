import { describe, expect, it, vi } from 'vitest';
import { afterSignUp, redactUrl, routable, safeNext, withoutSensitiveParams } from './redirect';

// The app's route table, as far as these tests need it: `match` answers null for anything else.
vi.mock('$app/paths', () => ({
	match: vi.fn(async (path: string) => {
		const pathname = new URL(path, 'https://app.example.com').pathname;
		return ['/app', '/app/settings'].includes(pathname) ? { id: pathname, params: {} } : null;
	}),
}));

describe('safeNext', () => {
	it('accepts same-origin paths', () => {
		expect(safeNext('/app')).toBe('/app');
		expect(safeNext('/app/x?y=1')).toBe('/app/x?y=1');
	});

	it('rejects protocol-relative and absolute URLs', () => {
		expect(safeNext('//evil.com')).toBeNull();
		expect(safeNext('https://evil.com')).toBeNull();
		expect(safeNext('javascript:alert(1)')).toBeNull();
	});

	it('rejects backslashes and whitespace', () => {
		expect(safeNext('/\\evil')).toBeNull();
		expect(safeNext('/app x')).toBeNull();
		expect(safeNext('/app\n')).toBeNull();
	});

	it('rejects empty and missing values', () => {
		expect(safeNext('')).toBeNull();
		expect(safeNext(null)).toBeNull();
		expect(safeNext(undefined)).toBeNull();
	});
});

describe('routable', () => {
	it('keeps a path a page answers, query included', async () => {
		expect(await routable('/app/settings?tab=profile')).toBe('/app/settings?tab=profile');
	});

	// SvelteKit 3's `goto` rejects these instead of loading the page in full, as Kit 2 did.
	it('falls back for a path no page answers', async () => {
		expect(await routable('/old-bookmark')).toBe('/app');
		expect(await routable('/old-bookmark', '/app/settings')).toBe('/app/settings');
	});
});

describe('afterSignUp', () => {
	it('carries a validated `next` through, and falls back to the app', () => {
		expect(afterSignUp(new URL('https://app.example.com/signup?next=%2Fapp%2Fsettings'))).toBe(
			'/app/settings',
		);
		expect(afterSignUp(new URL('https://app.example.com/signup?next=https%3A%2F%2Fevil.com'))).toBe(
			'/app',
		);
		expect(afterSignUp(new URL('https://app.example.com/signup'))).toBe('/app');
	});
});

describe('redactUrl', () => {
	it('redacts emailed credentials in an absolute URL, keeping everything else', () => {
		expect(redactUrl('https://app.example.com/reset-password?token=abc123&next=/app')).toBe(
			'https://app.example.com/reset-password?token=redacted&next=%2Fapp',
		);
	});

	it('redacts the address and one-time code in a path', () => {
		expect(redactUrl('/verify-email?email=a%40b.com&code=999999')).toBe(
			'/verify-email?email=redacted&code=redacted',
		);
	});

	it('leaves anything with nothing to redact untouched', () => {
		expect(redactUrl('/app')).toBe('/app');
		expect(redactUrl('not a url at all')).toBe('not a url at all');
	});
});

describe('withoutSensitiveParams', () => {
	it('drops the credentials and keeps the rest', () => {
		const url = new URL('https://app.example.com/reset-password?token=abc&error=X');
		expect(withoutSensitiveParams(url)).toBe('/reset-password?error=X');
	});

	it('answers null when there is nothing to remove', () => {
		expect(withoutSensitiveParams(new URL('https://app.example.com/login?next=/app'))).toBeNull();
	});
});
