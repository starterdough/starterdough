import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Every environment variable the app reads. `public: true` ones are imported from
 * `$app/env/public` and reach the browser; the rest come from `$app/env/private`, which SvelteKit
 * refuses to bundle for the client. apps/web/.env.example explains each one.
 *
 * All of them are optional: empty or unset means "not configured", and the code that reads one
 * supplies its default. SvelteKit fails startup on a variable with no validator that is unset, so
 * each gets `optional`, which accepts anything. None is `static`: they are read when the server
 * starts, so one Docker image serves any deployment. The static (Tauri) build has no server, so
 * there they are whatever was set at build time, as before.
 *
 * The Content-Security-Policy is built from the same `PUBLIC_*` values, but at build time, by
 * vite.config.ts; see the comment there.
 */
const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
	PUBLIC_API_URL: {
		public: true,
		schema: optional,
		description: 'Where the browser and the Tauri shells reach the API. Absolute.',
	},
	API_URL: {
		schema: optional,
		description: 'Internal API origin for server-side `load` calls. Defaults to PUBLIC_API_URL.',
	},
	PUBLIC_WEB_URL: {
		public: true,
		schema: optional,
		description: 'Origin of the deployed web app, for round trips that leave a Tauri shell.',
	},
	PUBLIC_DEMO_MODE: {
		public: true,
		schema: optional,
		description: '`true` on a public demo deployment.',
	},
	PUBLIC_SENTRY_DSN: { public: true, schema: optional, description: 'Browser error tracking.' },
	PUBLIC_SENTRY_ENVIRONMENT: { public: true, schema: optional },
	PUBLIC_SENTRY_TRACES_SAMPLE_RATE: { public: true, schema: optional },
	SENTRY_DSN: { schema: optional, description: 'Server-side (SSR) error tracking.' },
	SENTRY_ENVIRONMENT: { schema: optional },
	SENTRY_TRACES_SAMPLE_RATE: { schema: optional },
	PUBLIC_POSTHOG_KEY: {
		public: true,
		schema: optional,
		description: 'Product analytics, sent only after the visitor consents.',
	},
	PUBLIC_POSTHOG_HOST: { public: true, schema: optional },
});
