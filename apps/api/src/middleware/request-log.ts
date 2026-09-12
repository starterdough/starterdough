import { trustProxy } from '@repo/env';
import { createMiddleware } from 'hono/factory';
import type { RequestIdVariables } from 'hono/request-id';
import { type Logger, log, withLogContext } from '../log';
import { clientIp } from './rate-limit';

export interface RequestLogOptions {
	/** Logger to write through. Defaults to the process logger; tests pass a collector. */
	logger?: Logger;
	/**
	 * Paths whose successful (< 400) responses are not logged. Compose and Caddy poll the health
	 * probes every few seconds; a line per poll would bury everything else.
	 */
	quiet?: string[];
	/** Believe `x-forwarded-for` (see `clientIp`). Defaults to `TRUST_PROXY`. */
	trustProxy?: boolean;
}

/**
 * One structured line per request (`method, path, status, durationMs, ip, requestId`) instead of
 * Hono's development-only `logger()`. The level follows the status (5xx → error, 4xx → warn), so a
 * production log at `warn` still shows failing requests. Runs inside the tracing middleware, so
 * the line also carries `traceId`/`spanId` whenever telemetry is on.
 *
 * It also opens the log context for the request: `requestId`, `method` and `path` land on every line
 * anything downstream writes (`procedure failed`, a service call, `unhandled error`), so no code
 * path has to carry the id to be able to log it.
 */
export function requestLog(options: RequestLogOptions = {}) {
	const logger = (options.logger ?? log).with({ component: 'http' });
	const quiet = new Set(options.quiet ?? ['/healthz', '/readyz']);
	const trusted = options.trustProxy ?? trustProxy();

	return createMiddleware<{ Variables: RequestIdVariables }>(async (c, next) => {
		const started = performance.now();
		const path = c.req.path;

		await withLogContext(
			{ requestId: c.get('requestId'), method: c.req.method, path },
			async () => {
				await next();

				const status = c.res.status;
				if (status < 400 && quiet.has(path)) return;

				const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
				logger[level]('request', {
					status,
					durationMs: Math.round((performance.now() - started) * 10) / 10,
					ip: clientIp(c, trusted),
				});
			},
		);
	});
}
