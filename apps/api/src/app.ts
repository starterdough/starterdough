import { httpInstrumentationMiddleware } from '@hono/otel';
import { auth, CLIENT_IP_HEADER } from '@repo/auth/server';
import { pingDatabase } from '@repo/db';
import { trustedOrigins } from '@repo/env';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { log, rootCauseMessage } from './log';
import { clientIp, rateLimit } from './middleware/rate-limit';
import { requestLog } from './middleware/request-log';
import { mountRpc } from './rpc/handler';

/**
 * Route map
 *
 *   GET  /healthz                 liveness: the process answers HTTP — for restarts (compose healthcheck)
 *   GET  /readyz                  readiness: the database answers too — for routing traffic (Caddy, LB)
 *   *    /api/auth/*              Better Auth (sign-in, sessions, admin)
 *   POST /rpc/*                   oRPC RPC transport — used by our TypeScript clients
 *   *    /api/v1/*                the same procedures as plain REST (OpenAPI 3.1)
 *   GET  /api/v1/openapi.json     generated OpenAPI document
 *
 * Every response carries `X-Request-Id` (the client's own if it sent a well-formed one — Caddy
 * forwards one — else a fresh UUID); the same id is on the access-log line and on error lines.
 */
export const app = new Hono();

const allowedOrigins = new Set(trustedOrigins());

// Order matters: the id first so everything downstream can log it; the server span next so the
// access log and any error line inside it carry the trace id; then the log line itself.
app.use(requestId());
// A no-op until `startTelemetry()` registers a provider (the tracer is a proxy), so tests and
// OTEL-less deployments pay nothing. Header capture stays off: `authorization`/`cookie` must never
// reach a tracing backend. The middleware records the full URL, query string included, so `otel.ts`
// strips the query from every span (auth tokens, OAuth codes) and drops the probes' spans
// altogether.
app.use(httpInstrumentationMiddleware());
app.use(requestLog());

const baseHeaders = {
	// The API lives on its own origin (`api.` next to `app.`), so the browser treats every response
	// as cross-origin. The default `same-origin` CORP would make it refuse to *render* what it
	// fetched, without adding any protection: CORS and the session are what decide who may read
	// a response.
	crossOriginResourcePolicy: 'cross-origin' as const,
};

/**
 * Better Auth's Scalar reference is the only HTML this origin serves, and it pulls its script from a
 * CDN, so it is the one path that cannot take the CSP below. It is disabled in production
 * (`packages/auth`); in development it keeps working.
 */
const CSP_EXEMPT_PATH = '/api/auth/reference';

const strictHeaders = secureHeaders({
	...baseHeaders,
	// Nothing the API answers with is a document that may load anything or be framed. Cheap on a
	// JSON body and the whole defence if a response ever gets sniffed as HTML.
	contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
});
const referenceHeaders = secureHeaders(baseHeaders);

app.use((c, next) =>
	c.req.path === CSP_EXEMPT_PATH ? referenceHeaders(c, next) : strictHeaders(c, next),
);

/** The probes carry no tenant data and are polled every few seconds by machines that do not cache. */
const CACHE_HEADER_EXEMPT = new Set(['/healthz', '/readyz']);

/**
 * `private, no-store` on everything else. Every API answer is per-session by construction, so a
 * browser or proxy must never be free to keep one. An existing value is left alone rather than
 * overwritten, so a route that sets its own is not second-guessed.
 */
app.use(async (c, next) => {
	await next();
	if (CACHE_HEADER_EXEMPT.has(c.req.path)) return;
	if (!c.res.headers.has('cache-control')) {
		c.res.headers.set('cache-control', 'private, no-store');
	}
});

app.use(
	'*',
	cors({
		origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization'],
		exposeHeaders: ['set-auth-token'],
		maxAge: 600,
	}),
);

/**
 * Procedure bodies are JSON of a few kilobytes at most. The limit is what stops an unauthenticated
 * caller from making the API buffer `maxRequestBodySize` (`index.ts`) per request at the shared
 * 300/min/IP budget.
 */
const PROCEDURE_BODY_LIMIT = 1024 * 1024;
const procedureBodyLimit = bodyLimit({
	maxSize: PROCEDURE_BODY_LIMIT,
	onError: (c) => c.json({ error: 'payload_too_large', maxBytes: PROCEDURE_BODY_LIMIT }, 413),
});
app.use('/rpc/*', procedureBodyLimit);
app.use('/api/v1/*', procedureBodyLimit);

app.get('/healthz', (c) => c.json({ status: 'ok' }));

/** Readiness budget: a probe must answer well inside the poller's own timeout (Caddy: 5 s). */
const READINESS_TIMEOUT_MS = 2_000;

/**
 * Run one call at a time: everyone who asks while a call is in flight waits for that one. Exported
 * for its unit test.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= run().finally(() => {
			pending = null;
		});
		return pending;
	};
}

/**
 * Caddy and compose poll `/readyz` every few seconds, so a ping per poll against a hung Postgres
 * would take a pool connection each and starve the requests that matter: the probes share one.
 * `pingDatabase` bounds its query server-side with the same budget, so a ping the probes have
 * stopped waiting for does not outlive them either. Resolves to `ok` or to the reason it failed —
 * never rejects, because by then nobody may be waiting for it.
 */
const sharedPing = singleFlight<'ok' | string>(() =>
	pingDatabase(READINESS_TIMEOUT_MS).then(
		() => 'ok' as const,
		(error: unknown) => rootCauseMessage(error),
	),
);

/** Distinguishes "the timer won" from a ping that resolved, whatever the reason string says. */
const TIMED_OUT = Symbol('readiness timeout');

interface CheckFailure {
	/** What the response says: coarse on purpose, see the route below. */
	token: 'timeout' | 'unreachable';
	/** What the log says. */
	reason: string;
}

/** The check's outcome — never rejects, never hangs. */
async function checkDatabase(): Promise<'ok' | CheckFailure> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), READINESS_TIMEOUT_MS);
	});
	try {
		const outcome = await Promise.race([sharedPing(), timeout]);
		if (outcome === TIMED_OUT) {
			return { token: 'timeout', reason: `no answer within ${READINESS_TIMEOUT_MS}ms` };
		}
		return outcome === 'ok' ? 'ok' : { token: 'unreachable', reason: outcome };
	} finally {
		clearTimeout(timer);
	}
}

// Unlike `/healthz`, this one can flap: a restarting Postgres turns it 503 without restarting the
// API, which is exactly what a load balancer should act on and a container restart policy should not.
app.get('/readyz', async (c) => {
	const database = await checkDatabase();
	if (database === 'ok') return c.json({ status: 'ok', checks: { database: 'ok' } });
	// The probe is public (Caddy forwards it, and anyone may poll it), while what Postgres says names
	// the host, the user or the connection count: the reason goes to the log, a token to the caller.
	log.warn('readiness check failed', {
		check: 'database',
		outcome: database.token,
		reason: database.reason,
	});
	return c.json({ status: 'unavailable', checks: { database: database.token } }, 503);
});

/**
 * Better Auth rate-limits itself (see `rateLimit` in packages/auth/src/server.ts) but only reads
 * headers, so the client IP it keys on is handed over in a header the API always **overwrites**: a
 * caller that sends its own `x-starterdough-client-ip` would otherwise pick its own rate-limit bucket
 * (and the address recorded on the session) per request. Exported for its unit test.
 */
export function withClientIp(request: Request, ip: string): Request {
	const headers = new Headers(request.headers);
	headers.set(CLIENT_IP_HEADER, ip);
	return new Request(request, { headers });
}

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(withClientIp(c.req.raw, clientIp(c))));

// Per-IP guardrail for the procedures, shared by both transports. Generous on purpose:
// it stops runaway clients, not determined abuse — put that at the edge (Caddy/Cloudflare).
const procedureLimiter = rateLimit({ windowMs: 60_000, max: 300 });
app.use('/rpc/*', procedureLimiter);
app.use('/api/v1/*', procedureLimiter);

// The public contact form sends email on every call: a few per hour per IP is plenty.
const contactLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5 });
app.use('/rpc/contact/*', contactLimiter);
app.use('/api/v1/contact', contactLimiter);

mountRpc(app);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((error, c) => {
	const requestId = c.get('requestId');
	log.error('unhandled error', { error, requestId });
	// The id is on `X-Request-Id` too, but a caller reporting a failure quotes the body.
	return c.json({ error: 'internal_error', requestId }, 500);
});

export type App = typeof app;
