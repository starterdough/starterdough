import { pg } from '@repo/db';
import { env } from '@repo/env';
import { app } from './app';
import { flushErrorReporting, startErrorReporting } from './error-reporting';
import { createShutdown, installProcessHandlers } from './lifecycle';
import { log } from './log';
import { shutdownTelemetry, startTelemetry } from './otel';
import { version } from './rpc/version';

// Before the server: a request must never arrive while the tracer is still a no-op proxy.
const telemetry = await startTelemetry({ serviceName: 'starterdough-api' });
const errorReporting = await startErrorReporting({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
	release: version,
	serverName: 'starterdough-api',
});

/** The largest body any route can accept; procedure bodies are capped far lower in `app.ts`. */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

const server = Bun.serve({
	port: env.PORT,
	fetch: app.fetch,
	maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
	// Long enough for streaming responses (SSE from oRPC event iterators) without
	// keeping dead connections around forever.
	idleTimeout: 120,
});

log.info('api listening', {
	url: server.url.href,
	env: env.NODE_ENV,
	tracing: telemetry.enabled,
	errorReporting,
});

installProcessHandlers(
	createShutdown({
		async drain() {
			// Stop accepting connections; requests already in progress keep running for now.
			const drained = server.stop();
			await drained;
			log.info('in-flight requests finished');
		},
		async onDrainTimeout(afterMs) {
			log.warn('forcing remaining connections closed', { afterMs });
			await server.stop(true);
		},
		flushTelemetry: async (capMs) => {
			await Promise.all([shutdownTelemetry(telemetry, capMs), flushErrorReporting(capMs)]);
		},
		closeDatabase: (timeout) => pg.close({ timeout }),
	}),
);
