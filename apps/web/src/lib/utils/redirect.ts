/**
 * Validate a `?next=` return path before redirecting to it.
 *
 * Only same-origin absolute paths pass: a single leading `/`, no `//host` (protocol-relative),
 * no scheme, no backslashes (browsers turn `/\evil` into `//evil`) and no whitespace.
 * Anything else yields `null` so callers fall back to a known-safe default.
 */
export function safeNext(value: string | null | undefined): string | null {
	if (!value) return null;
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	if (/[\\\s]/.test(value)) return null;
	return value;
}

/**
 * Where sign-up lands when nothing else was requested: the validated `?next=` when the link
 * carried one, else the app.
 */
export function afterSignUp(url: URL): string {
	return safeNext(url.searchParams.get('next')) ?? '/app';
}

/**
 * Query parameters that must never leave the browser or stay in the address bar: the credentials
 * Better Auth mails out (`token` for password reset, `code` for one-time codes) and the address
 * they were sent to. A page reads them into state once and drops them from the URL; analytics and
 * error reporting redact them from any URL they would send ($lib/analytics.svelte.ts,
 * src/hooks.client.ts).
 */
export const SENSITIVE_PARAMS = ['token', 'code', 'email'] as const;

const REDACTED = 'redacted';

/** True when `url` carries at least one sensitive parameter. */
function hasSensitiveParams(url: URL): boolean {
	return SENSITIVE_PARAMS.some((key) => url.searchParams.has(key));
}

/**
 * The same URL with every sensitive parameter's value replaced. Takes an absolute URL or a path
 * and gives back the same shape, so it works on `$current_url` as well as on `$pathname`-like
 * values. Values it cannot parse, and URLs with nothing to redact, come back unchanged.
 */
export function redactUrl(value: string): string {
	if (!value.includes('?')) return value;
	const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
	let url: URL;
	try {
		url = absolute ? new URL(value) : new URL(value, 'http://redacted.invalid');
	} catch {
		return value;
	}
	if (!hasSensitiveParams(url)) return value;
	for (const key of SENSITIVE_PARAMS) {
		if (url.searchParams.has(key)) url.searchParams.set(key, REDACTED);
	}
	return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The path to replace the current history entry with once a page has read its credentials into
 * state, or `null` when there is nothing to remove. Keeps every other parameter (`?next=`, an
 * error code) so a reload still behaves the same.
 */
export function withoutSensitiveParams(url: URL): string | null {
	if (!hasSensitiveParams(url)) return null;
	const stripped = new URL(url);
	for (const key of SENSITIVE_PARAMS) stripped.searchParams.delete(key);
	return `${stripped.pathname}${stripped.search}${stripped.hash}`;
}
