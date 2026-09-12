import { trustProxy } from '@repo/env';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';

export interface RateLimitOptions {
	/** Window length in milliseconds. */
	windowMs: number;
	/** Requests allowed per key per window. */
	max: number;
	/** Bucket key for a request. Defaults to the client IP. */
	keyFor?: (c: Context) => string;
	/** Believe `x-forwarded-for` (see `clientIp`). Defaults to `TRUST_PROXY`. */
	trustProxy?: boolean;
	/** Clock, injectable for tests. */
	now?: () => number;
}

interface Bucket {
	count: number;
	resetAt: number;
}

/**
 * The client IP every request-scoped decision uses: rate-limit buckets and the access log's `ip`.
 *
 * `x-forwarded-for` is a request header like any other, so it is read only where a proxy actually
 * sets it (`TRUST_PROXY=true`: Caddy in `infra/compose.yml`, which drops client-supplied values),
 * and even then only when it holds exactly one address: a multi-hop chain is spoofable without a
 * trusted-proxy list. Everything else falls back to the socket address, which is also what local
 * development sees. Reaching the API directly must never let a caller choose its own limiter key.
 */
export function clientIp(c: Context, trusted: boolean = trustProxy()): string {
	const forwarded = trusted ? c.req.header('x-forwarded-for')?.trim() : undefined;
	if (forwarded && !forwarded.includes(',')) return forwarded;
	try {
		return getConnInfo(c).remote.address ?? 'unknown';
	} catch {
		// No Bun server in the context (e.g. `app.request()` in tests).
		return 'unknown';
	}
}

/**
 * Fixed-window, in-process limiter, sized for one API container. It guards the
 * procedures (`/rpc/*`, `/api/v1/*`); `/api/auth/*` is throttled by Better Auth itself.
 * Swap the `Map` for Redis/Postgres before running several replicas.
 *
 * Responses carry `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (seconds);
 * rejected requests get `429` with `Retry-After`.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
	const {
		windowMs,
		max,
		trustProxy: trusted = trustProxy(),
		keyFor = (c: Context) => clientIp(c, trusted),
		now = Date.now,
	} = options;
	const buckets = new Map<string, Bucket>();
	let lastSweep = 0;

	return async (c, next) => {
		const t = now();

		// Drop expired buckets at most once per window so the map cannot grow unbounded.
		if (t - lastSweep >= windowMs) {
			for (const [key, bucket] of buckets) if (bucket.resetAt <= t) buckets.delete(key);
			lastSweep = t;
		}

		const key = keyFor(c);
		let bucket = buckets.get(key);
		if (!bucket || bucket.resetAt <= t) {
			bucket = { count: 0, resetAt: t + windowMs };
			buckets.set(key, bucket);
		}
		bucket.count += 1;

		const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
		c.header('RateLimit-Limit', String(max));
		c.header('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
		c.header('RateLimit-Reset', String(resetSeconds));

		if (bucket.count > max) {
			c.header('Retry-After', String(resetSeconds));
			return c.json({ error: 'rate_limited', retryAfter: resetSeconds }, 429);
		}

		await next();
	};
}
