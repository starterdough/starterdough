import type { ErrorEvent } from '@sentry/node';
import { stripSearch } from './otel';

/**
 * Optional error tracking for the API's processes (Sentry), the server-side twin of apps/web's
 * hooks. Off unless `SENTRY_DSN` is set: then the SDK is imported, and never otherwise.
 *
 * Errors only. Traces stay with OpenTelemetry (`otel.ts`): `skipOpenTelemetrySetup` keeps Sentry
 * from registering a second global tracer provider, so no span reaches Sentry, whatever
 * `SENTRY_TRACES_SAMPLE_RATE` the shared `.env` holds for the web container. Nothing else reaches
 * it on its own either: every report comes from a `reportError` call next to a log line, with the
 * ids that line carries and never an email address.
 */
type Sentry = typeof import('@sentry/node');
let sentry: Sentry | null = null;

export interface ErrorReportingOptions {
	dsn: string | undefined;
	environment: string;
	release: string;
	/** Which process this is, e.g. `starterdough-api`. The SDK would otherwise send the hostname. */
	serverName: string;
}

/** Default integrations left out, by name. */
const EXCLUDED_INTEGRATIONS: ReadonlySet<string> = new Set([
	// `lifecycle.ts` owns the process's fatal errors: it logs them, reports them here and exits.
	'OnUncaughtException',
	'OnUnhandledRejection',
	// Request data and breadcrumbs of outgoing calls. Their URLs carry what `stripSearch` removes
	// from spans: signed-URL signatures, verification tokens, OAuth codes.
	'Http',
	'NodeFetch',
	// Console breadcrumbs and a crashing frame's local variables, either of which can hold a session
	// token or a bound query parameter.
	'Console',
	'LocalVariables',
	'LocalVariablesAsync',
]);

/**
 * Drizzle's `DrizzleQueryError` message is the failed statement followed by every bound value
 * (`Failed query: <sql>\nparams: <values>`), session tokens included; `log.ts` replaces it for the
 * same reason. The linked cause, which Sentry sends alongside, says what Postgres said.
 */
const FAILED_QUERY = /^Failed query: /;
const WITHHELD_QUERY = 'Failed query (statement and parameters withheld; see the linked cause)';

/** `beforeSend`: withholds failed statements, and strips the query string from a request URL. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
	for (const exception of event.exception?.values ?? []) {
		if (exception.value && FAILED_QUERY.test(exception.value)) exception.value = WITHHELD_QUERY;
	}
	if (event.request?.url) event.request.url = stripSearch(event.request.url);
	if (event.request) delete event.request.query_string;
	return event;
}

/** True once `startErrorReporting` has started the SDK. */
export const errorReportingEnabled = () => sentry !== null;

/** Starts the SDK when a DSN is set. Resolves to whether reports will be sent. */
export async function startErrorReporting(options: ErrorReportingOptions): Promise<boolean> {
	if (!options.dsn) return false;
	const sdk = await import('@sentry/node');
	const client = sdk.init({
		dsn: options.dsn,
		environment: options.environment,
		release: options.release,
		serverName: options.serverName,
		sendDefaultPii: false,
		skipOpenTelemetrySetup: true,
		// The loader hook serves OpenTelemetry's auto-instrumentation, which nothing here uses.
		registerEsmLoaderHooks: false,
		integrations: (defaults) =>
			defaults.filter((integration) => !EXCLUDED_INTEGRATIONS.has(integration.name)),
		beforeSend: scrubEvent,
	});
	// A DSN the SDK cannot parse leaves it running but sending nothing; it says why on stderr.
	if (!client?.getDsn()) return false;
	sentry = sdk;
	return true;
}

/**
 * Sends `error` to Sentry, in the background. A no-op while error tracking is off. `fields` are
 * ids (`requestId`, `procedure`, `jobId`, `workerId`), attached as the event's extra data.
 */
export function reportError(error: unknown, fields: Record<string, unknown> = {}): void {
	sentry?.captureException(error, { extra: fields });
}

/** Waits up to `timeoutMs` for queued reports to go out. Never rejects; false if some did not. */
export async function flushErrorReporting(timeoutMs: number): Promise<boolean> {
	if (!sentry) return true;
	try {
		return await sentry.flush(timeoutMs);
	} catch {
		return false;
	}
}
