import { pg } from '@repo/db';
import { env } from '@repo/env';
import { app } from './app';
import { createShutdown, installProcessHandlers } from './lifecycle';
import { log } from './log';
import { shutdownTelemetry, startTelemetry } from './otel';

// Before the server: a request must never arrive while the tracer is still a no-op proxy.
const telemetry = await startTelemetry({ serviceName: 'starterdough-api' });

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
		flushTelemetry: (capMs) => shutdownTelemetry(telemetry, capMs),
		closeDatabase: (timeout) => pg.close({ timeout }),
	}),
);
