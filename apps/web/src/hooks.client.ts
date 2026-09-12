import type { HandleClientError } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { storedConsent } from '$lib/analytics.svelte';
import { m } from '$lib/paraglide/messages';
import { redactUrl } from '$lib/utils/redirect';

/**
 * Error tracking (Sentry) is a deployment option: set `PUBLIC_SENTRY_DSN` and the SDK is loaded
 * only then, so deployments without it ship none of it. Server-side errors are reported from
 * hooks.server.ts with `SENTRY_DSN`.
 *
 * Two privacy rules apply here. Performance tracing is analytics, so it is switched on only for a
 * visitor who accepted the consent banner (an error report itself is not: it carries no profile and
 * the app cannot be fixed without it). And every URL leaving for Sentry is redacted, because the
 * reset-password and verify-email links carry a credential in their query string.
 */
const dsn = env.PUBLIC_SENTRY_DSN;
const tracing = storedConsent() === 'granted';

const sentry = dsn
	? import('@sentry/sveltekit').then((Sentry) => {
			Sentry.init({
				dsn,
				environment: env.PUBLIC_SENTRY_ENVIRONMENT || (dev ? 'development' : 'production'),
				tracesSampleRate: tracing ? Number(env.PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1) : 0,
				integrations: tracing ? [Sentry.browserTracingIntegration()] : [],
				beforeSend: (event) => {
					if (event.request?.url) event.request.url = redactUrl(event.request.url);
					return event;
				},
				beforeBreadcrumb: (breadcrumb) => {
					const data = breadcrumb.data;
					if (data) {
						for (const key of ['url', 'to', 'from'] as const) {
							if (typeof data[key] === 'string') data[key] = redactUrl(data[key]);
						}
					}
					return breadcrumb;
				},
			});
			return Sentry;
		})
	: null;

/** Unexpected errors: report (or log), and hand the UI a safe message with a reference id. */
export const handleError: HandleClientError = async ({ error, event, status, message }) => {
	const id = crypto.randomUUID();
	if (sentry) {
		(await sentry).captureException(error, {
			extra: { id, status, message, path: event.url.pathname },
		});
	} else {
		console.error(error);
	}
	return {
		message: status === 404 ? m.common_error_not_found_title() : m.common_error_generic(),
		id,
	};
};
