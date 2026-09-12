import {
	context,
	type DiagLogger,
	DiagLogLevel,
	diag,
	propagation,
	trace,
} from '@opentelemetry/api';
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
	ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
	ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';
import { env } from '@repo/env';
import { log } from './log';
import { version } from './rpc/version';

/**
 * Distributed tracing with the standard OpenTelemetry JS SDK.
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set: then the SDK is never even imported (only the
 * API package and the attribute-name constants are), and every `trace.getTracer(...)` call in the
 * codebase (the Hono middleware and every service module behind it) hits the API package's no-op
 * proxies. With an endpoint, spans go over OTLP/HTTP to a collector (or straight to a hosted
 * backend; the exporter also honours `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
 * `OTEL_EXPORTER_OTLP_HEADERS`), `traceparent` headers are accepted from Caddy/clients and sent on
 * to the services behind the API, and `log` lines carry `traceId`.
 *
 * Bun 1.4 has no built-in OpenTelemetry (`Bun.otel` does not exist yet), so this is the plain SDK:
 * a `BasicTracerProvider` with a batching processor, `AsyncLocalStorage` for context propagation
 * across awaits, and W3C `traceparent` + `baggage` on the wire. SDK 2.x dropped
 * `provider.register()`, so the three globals are set by hand.
 */
export interface Telemetry {
	enabled: boolean;
	/** Flush pending spans and stop the exporter. Safe to call when disabled. */
	shutdown(): Promise<void>;
}

export interface TelemetryOptions {
	/** `service.name` unless `OTEL_SERVICE_NAME` overrides it: `starterdough-api` or `starterdough-worker`. */
	serviceName: string;
}

// The API globals can be registered once per process, and `bun --hot` re-runs the entrypoint:
// keep the live handle on `globalThis` (same trick as the job worker) and hand it back.
const TELEMETRY = Symbol.for('starterdough.telemetry');
type Global = typeof globalThis & { [TELEMETRY]?: Telemetry };

/**
 * `url.full` without its query string. The query is where the secrets travel: the presigned
 * `/uploads` signature (`?exp=&sig=`, which *is* the authorization), Better Auth's
 * `verify-email?token=`, an OAuth `callback?code=&state=`. None of it belongs in a backend.
 */
export function stripSearch(url: string): string {
	const at = url.indexOf('?');
	return at === -1 ? url : url.slice(0, at);
}

/** Polled every few seconds by compose and Caddy, and never saying anything new: not traced. */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

export function isProbeUrl(url: string): boolean {
	try {
		return PROBE_PATHS.has(new URL(url).pathname);
	} catch {
		return false;
	}
}

/** Rewrites `url.full` as each span starts, so no later processor or exporter sees the query. */
const stripSearchProcessor: SpanProcessor = {
	onStart(span) {
		const url = span.attributes[ATTR_URL_FULL];
		if (typeof url === 'string') span.setAttribute(ATTR_URL_FULL, stripSearch(url));
	},
	onEnd() {},
	forceFlush: async () => {},
	shutdown: async () => {},
};

// The SDK reports its own trouble (a collector refusing exports, say) through `diag`, which is
// silent until a logger is set. Warnings and errors go to the process log; the chatter stays off.
const otelLog = log.with({ component: 'otel' });
const detail = (args: unknown[]) => (args.length > 0 ? { detail: args } : undefined);
const diagLogger: DiagLogger = {
	error: (message, ...args) => otelLog.error(message, detail(args)),
	warn: (message, ...args) => otelLog.warn(message, detail(args)),
	info: () => {},
	debug: () => {},
	verbose: () => {},
};

export async function startTelemetry(options: TelemetryOptions): Promise<Telemetry> {
	const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return { enabled: false, shutdown: async () => {} };

	const g = globalThis as Global;
	if (g[TELEMETRY]) return g[TELEMETRY];

	diag.setLogger(diagLogger, DiagLogLevel.WARN);

	const [
		{
			AlwaysOnSampler,
			BasicTracerProvider,
			BatchSpanProcessor,
			ParentBasedSampler,
			SamplingDecision,
		},
		{ OTLPTraceExporter },
		{ resourceFromAttributes },
		{ AsyncLocalStorageContextManager },
		{ CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator },
	] = await Promise.all([
		import('@opentelemetry/sdk-trace-base'),
		import('@opentelemetry/exporter-trace-otlp-http'),
		import('@opentelemetry/resources'),
		import('@opentelemetry/context-async-hooks'),
		import('@opentelemetry/core'),
	]);

	// The SDK's own default (`parentbased_always_on`), minus the probes. `@hono/otel` only names
	// the span after its matched route once the request has finished. When the sampler runs,
	// `http.route` is still the middleware's own `/*`, so the URL is what identifies a probe.
	const defaultSampler = new ParentBasedSampler({ root: new AlwaysOnSampler() });
	const sampler: Sampler = {
		shouldSample(ctx, traceId, name, kind, attributes, links) {
			const url = attributes[ATTR_URL_FULL];
			if (typeof url === 'string' && isProbeUrl(url)) {
				return { decision: SamplingDecision.NOT_RECORD };
			}
			return defaultSampler.shouldSample(ctx, traceId, name, kind, attributes, links);
		},
		toString: () => `ProbeFree(${defaultSampler.toString()})`,
	};

	const serviceName = env.OTEL_SERVICE_NAME || options.serviceName;
	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_SERVICE_VERSION]: version,
			[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV ?? 'development',
		}),
		sampler,
		// The query stripper first, ahead of the batcher. No URL on the exporter on purpose: it
		// derives `<endpoint>/v1/traces` from the standard variables itself, so hosted backends work
		// with the documented OTEL_* knobs alone.
		spanProcessors: [stripSearchProcessor, new BatchSpanProcessor(new OTLPTraceExporter())],
	});

	const contextManager = new AsyncLocalStorageContextManager();
	contextManager.enable();
	trace.setGlobalTracerProvider(provider);
	context.setGlobalContextManager(contextManager);
	propagation.setGlobalPropagator(
		new CompositePropagator({
			propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
		}),
	);

	log.info('telemetry started', { endpoint, serviceName, version });

	const telemetry: Telemetry = {
		enabled: true,
		async shutdown() {
			// `shutdown()` flushes too, but an explicit flush first surfaces export errors separately
			// from teardown problems in the logs.
			try {
				await provider.forceFlush();
			} catch (error) {
				log.warn('telemetry flush failed', { error });
			}
			await provider.shutdown();
			contextManager.disable();
			delete g[TELEMETRY];
		},
	};
	g[TELEMETRY] = telemetry;
	return telemetry;
}

/**
 * `telemetry.shutdown()` with a deadline. An unreachable collector makes the OTLP export wait out
 * its own 10 s timeout, which the shutdown budget in `index.ts` / `worker.ts` cannot afford; past
 * `capMs` the pending spans are abandoned and the caller moves on to closing the database.
 */
export async function shutdownTelemetry(telemetry: Telemetry, capMs: number): Promise<void> {
	// The loser of the race is nobody's business afterwards, so the shutdown promise has to settle on
	// its own: past `capMs` a rejection would otherwise arrive unhandled, mid-exit.
	const outcome = await Promise.race([
		telemetry.shutdown().then(
			() => 'flushed' as const,
			(error: unknown) => {
				log.warn('telemetry shutdown failed', { error });
				return 'failed' as const;
			},
		),
		Bun.sleep(capMs).then(() => 'pending' as const),
	]);
	if (outcome === 'pending') {
		log.warn('telemetry shutdown still pending, abandoning it', { afterMs: capMs });
	}
}
