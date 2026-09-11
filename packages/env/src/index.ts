import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/**
 * Secrets whose value must be a real one in production. A deployment that boots with what the
 * example file suggests has a publicly known session-signing key (anyone can mint a session cookie)
 * or database password, so validation refuses it here — the one place every process routes through
 * — instead of trusting whoever copied the file to notice. Development and test keep the
 * placeholders: that is what makes `cp .env.example .env` work, and nothing is exposed there.
 */
const PRODUCTION_SECRETS = [
	'BETTER_AUTH_SECRET',
	'GITHUB_CLIENT_SECRET',
	'GOOGLE_CLIENT_SECRET',
	'RESEND_API_KEY',
] as const;

/** Database passwords the example file and the compose defaults ship with. */
const EXAMPLE_DATABASE_PASSWORDS: ReadonlySet<string> = new Set(['starterdough', 'postgres']);

const isPlaceholder = (value: string) => value.toLowerCase().startsWith('change-me');

/** One thing wrong with the configuration, on the variable it is wrong on. */
export interface ConfigurationIssue {
	name: string;
	message: string;
}

/** The password inside a connection URL (`postgres://user:password@host/db`), if it has one. */
function urlPassword(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		return decodeURIComponent(new URL(url).password) || undefined;
	} catch {
		return undefined;
	}
}

function hostnameOf(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length > 0 ? value : undefined;

/** Variables still holding an example placeholder, with what to say about them. */
export function placeholderSecrets(values: Record<string, unknown>): ConfigurationIssue[] {
	if (values.NODE_ENV !== 'production') return [];
	const found: ConfigurationIssue[] = [];
	for (const name of PRODUCTION_SECRETS) {
		const value = values[name];
		if (typeof value === 'string' && isPlaceholder(value)) {
			found.push({
				name,
				message: `${name} still holds the example placeholder: generate a real secret (\`openssl rand -hex 32\`) before running in production.`,
			});
		}
	}
	const password = urlPassword(values.DATABASE_URL);
	if (
		password !== undefined &&
		(isPlaceholder(password) || EXAMPLE_DATABASE_PASSWORDS.has(password))
	) {
		found.push({
			name: 'DATABASE_URL',
			message:
				'DATABASE_URL still uses a development database password: set a generated POSTGRES_PASSWORD before running in production.',
		});
	}
	return found;
}

/**
 * Reserved and example domains no real mail can be sent from. A provider rejects the send and
 * Better Auth swallows the failure, so the symptom is "the verification email never arrived" with
 * sign-up looking like it worked.
 */
const UNSENDABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
	'localhost',
	'local',
	'localdomain',
	'example',
	'example.com',
	'example.net',
	'example.org',
	'invalid',
	'test',
]);

/** The address out of `Display Name <someone@host>`, or the value itself when it is bare. */
function emailAddress(value: string): string {
	const angled = /<([^<>]+)>\s*$/.exec(value.trim());
	return (angled?.[1] ?? value).trim();
}

/** Lowercased domain of an `EMAIL_FROM` value, or `undefined` when there is no `@host` part. */
export function emailFromDomain(value: string): string | undefined {
	const address = emailAddress(value);
	const at = address.lastIndexOf('@');
	if (at <= 0 || at === address.length - 1) return undefined;
	// A trailing dot is a legal absolute FQDN (`localhost.`) — compare without it.
	return (
		address
			.slice(at + 1)
			.toLowerCase()
			.replace(/\.$/, '') || undefined
	);
}

/**
 * Configuration that produces a working-looking production deploy and is wrong. Each of these was
 * silent before: no provider meant transactional email went to `console.log` (verification and
 * password-reset URLs with their tokens, on a box whose logs are shipped somewhere).
 */
export function productionRequirements(values: Record<string, unknown>): ConfigurationIssue[] {
	if (values.NODE_ENV !== 'production') return [];
	const found: ConfigurationIssue[] = [];

	// Resend is the only provider `@repo/email` can construct. Adding SMTP means adding its switch
	// here too, or production silently falls back to the console provider again.
	if (!text(values.RESEND_API_KEY)) {
		found.push({
			name: 'RESEND_API_KEY',
			message:
				'RESEND_API_KEY is empty, so @repo/email falls back to the console provider: nobody can verify an address or reset a password, and the message bodies (with their tokens) would be written to the log. Set it, or wire another provider in packages/email and add its switch to productionRequirements().',
		});
	}

	const from = text(values.EMAIL_FROM);
	const domain = from === undefined ? undefined : emailFromDomain(from);
	if (domain === undefined || !domain.includes('.') || UNSENDABLE_EMAIL_DOMAINS.has(domain)) {
		found.push({
			name: 'EMAIL_FROM',
			message: `EMAIL_FROM must be an address on a domain you have verified with your email provider${
				domain ? ` — "${domain}" is not one` : ''
			}. \`Starterdough <noreply@localhost>\` is the development default and every provider rejects it.`,
		});
	}

	return found;
}

/**
 * `COOKIE_DOMAIN` goes verbatim into the session cookie's `Domain`, and a browser silently drops a
 * cookie whose domain does not cover the origin that set it — sign-in appears to succeed and the
 * session never sticks, with no error anywhere. So both origins the session is used from have to
 * sit under it. Applies in every environment: the failure mode is identical on a dev machine.
 */
export function cookieDomainIssues(values: Record<string, unknown>): ConfigurationIssue[] {
	const configured = text(values.COOKIE_DOMAIN);
	if (configured === undefined) return [];
	const domain = configured.replace(/^\./, '').toLowerCase();
	const found: ConfigurationIssue[] = [];
	for (const name of ['WEB_URL', 'API_URL'] as const) {
		const host = hostnameOf(values[name]);
		if (host === undefined) continue;
		if (host !== domain && !host.endsWith(`.${domain}`)) {
			found.push({
				name: 'COOKIE_DOMAIN',
				message: `COOKIE_DOMAIN is "${configured}" but ${name} is on "${host}", which is not under it, so the browser drops every session cookie. Use the parent domain both origins share (e.g. ".example.com" for app.example.com and api.example.com), or leave COOKIE_DOMAIN empty when they are one origin.`,
			});
		}
	}
	return found;
}

/** Every cross-field rule, in the order a reader would want to fix them. */
export function configurationIssues(values: Record<string, unknown>): ConfigurationIssue[] {
	return [
		...placeholderSecrets(values),
		...productionRequirements(values),
		...cookieDomainIssues(values),
	];
}

/**
 * `SKIP_ENV_VALIDATION` is for steps that never boot the app: typecheck, lint, `auth:schema`, unit
 * tests, CI builds. It used to hand `process.env` through unparsed, which made the typed object a
 * lie — `env.WORKER_ENABLED` was the string `'true'`, `env.PORT` a string, `env.MAX_UPLOAD_BYTES`
 * undefined — and every reader had to carry a defensive fallback. So the schema still runs, with
 * its coercions, transforms and defaults; only the two variables that have no default are filled
 * in, and the cross-field rules are skipped (nothing is being deployed).
 */
const SKIP_VALIDATION_FALLBACKS: Record<string, string> = {
	DATABASE_URL: 'postgres://starterdough:starterdough@localhost:5433/starterdough',
	BETTER_AUTH_SECRET: 'skip-env-validation-placeholder-not-a-secret',
};

const skipValidation = Boolean(process.env.SKIP_ENV_VALIDATION);

function runtimeEnvironment(): Record<string, string | undefined> {
	if (!skipValidation) return process.env;
	const values: Record<string, string | undefined> = { ...process.env };
	for (const [name, fallback] of Object.entries(SKIP_VALIDATION_FALLBACKS)) {
		if (!values[name]) values[name] = fallback;
	}
	return values;
}

/**
 * Server-side environment for the API, workers and CLI tooling.
 *
 * - Validated once at import time; a missing/invalid variable fails fast with a readable error.
 * - `SKIP_ENV_VALIDATION=1` relaxes it for steps that never boot the app (see above) — the values
 *   are still parsed, so they keep their real types.
 * - The SvelteKit app does NOT use this module; it reads `PUBLIC_*` via `$env/dynamic/public`.
 */
export const env = createEnv({
	server: {
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
		PORT: z.coerce.number().int().positive().default(3000),

		/** Public origin of the API. */
		API_URL: z.url().default('http://localhost:3000'),
		/** Public origin of the web app. */
		WEB_URL: z.url().default('http://localhost:5173'),
		/** Comma-separated extra origins (Tauri shells, LAN devices, tailnet hosts). */
		TRUSTED_ORIGINS: z.string().default(''),
		/**
		 * Parent domain for cross-subdomain session cookies, e.g. `.example.com`. A bare hostname
		 * with an optional leading dot — no scheme, no port, no path: the value goes straight into
		 * `Set-Cookie`'s `Domain`, where anything else makes the browser drop the cookie without a
		 * word. `WEB_URL` and `API_URL` must both sit under it (see `cookieDomainIssues`).
		 */
		COOKIE_DOMAIN: z
			.string()
			.regex(
				/^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i,
				'COOKIE_DOMAIN must be a bare hostname such as `.example.com` — no scheme, port or path.',
			)
			.optional(),
		/**
		 * Whether a reverse proxy in front of the API sets `X-Forwarded-For`. `true` trusts its first
		 * hop as the client IP (rate-limit buckets, access-log `ip`); `false` — the default, and the
		 * only safe value when the API is reachable directly — uses the socket address, because any
		 * caller can send that header. Set it wherever Caddy/an LB terminates the connection.
		 */
		TRUST_PROXY: z
			.enum(['true', 'false'])
			.transform((v) => v === 'true')
			.default(false),

		DATABASE_URL: z.url(),
		/**
		 * Connections one process may hold open to Postgres. Every API replica and every worker has
		 * its own pool, and Postgres refuses connections past `max_connections` (100 by default) —
		 * see the sizing note in `packages/db/src/client.ts`.
		 */
		DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

		/** Log line format. Unset → `json` in production (for collectors), `pretty` elsewhere. */
		LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
		/** Lines below this level are dropped. Unset → `info` in production, `debug` elsewhere. */
		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
		/**
		 * Base URL of an OTLP/HTTP collector, e.g. `http://otel-collector:4318`. This is the standard
		 * OpenTelemetry variable, read by the exporters themselves; unset means tracing is off and the
		 * SDK is never loaded. `OTEL_EXPORTER_OTLP_HEADERS` works too (auth for hosted backends).
		 */
		OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
		/** `service.name` on exported spans. Unset → `starterdough-api` / `starterdough-worker` / `starterdough-ai`. */
		OTEL_SERVICE_NAME: z.string().optional(),

		BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
		/** Gate sessions on a verified email. Unset → true in production, false elsewhere. */
		REQUIRE_EMAIL_VERIFICATION: z
			.enum(['true', 'false'])
			.transform((v) => v === 'true')
			.optional(),
		GITHUB_CLIENT_ID: z.string().optional(),
		GITHUB_CLIENT_SECRET: z.string().optional(),
		GOOGLE_CLIENT_ID: z.string().optional(),
		GOOGLE_CLIENT_SECRET: z.string().optional(),

		EMAIL_FROM: z.string().default('Starterdough <noreply@localhost>'),
		RESEND_API_KEY: z.string().optional(),
		/** Recipient of the public contact form (`contact.send`). Required once a real provider is set. */
		CONTACT_EMAIL: z.email().optional(),
	},
	// Cross-field validation runs on the parsed object, once, next to the per-variable rules.
	createFinalSchema: (shape) =>
		z.object(shape).superRefine((values, ctx) => {
			// Nothing is being deployed under SKIP_ENV_VALIDATION, and the caller may legitimately
			// have no email provider or service token there.
			if (skipValidation) return;
			for (const { name, message } of configurationIssues(values)) {
				ctx.addIssue({ code: 'custom', path: [name], message });
			}
		}),
	runtimeEnv: runtimeEnvironment(),
	emptyStringAsUndefined: true,
});

export type Env = typeof env;

/** Split a comma-separated list, tolerating undefined. */
export function parseList(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

export const isProduction = env.NODE_ENV === 'production';

/**
 * How log lines are written: JSON for production (one object per line, for Loki/Datadog/`docker
 * logs | jq`) and a coloured single line for a developer's terminal. `LOG_FORMAT` overrides.
 */
export function logFormat(): 'json' | 'pretty' {
	return env.LOG_FORMAT ?? (isProduction ? 'json' : 'pretty');
}

/**
 * Lowest level that still gets written: `debug` while developing, `info` in production (a debug line
 * per database query and per job poll is noise there). `LOG_LEVEL` overrides.
 */
export function logLevel(): 'debug' | 'info' | 'warn' | 'error' {
	return env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug');
}

/** Whether `X-Forwarded-For` may be believed (see `TRUST_PROXY`). */
export function trustProxy(): boolean {
	return env.TRUST_PROXY;
}

/**
 * Origins that call the API from a browser context in development and are allowed out of the box:
 * the Astro sites (contact form, the docs' API reference) and the Tauri shell — its dev server
 * (`apps/web` `dev:static` on :5175) and the bundled SPA's own origin (`http://tauri.localhost` on
 * Windows, `tauri://localhost` elsewhere). Production lists the real ones in `TRUSTED_ORIGINS`.
 */
const developmentOrigins = isProduction
	? []
	: [
			'http://localhost:4321',
			'http://localhost:4322',
			'http://localhost:5175',
			'http://tauri.localhost',
			'https://tauri.localhost',
			'tauri://localhost',
		];

/** Every origin allowed to call the API and to be redirected to after auth. */
export function trustedOrigins(): string[] {
	return [
		...new Set([env.WEB_URL, ...parseList(env.TRUSTED_ORIGINS), ...developmentOrigins]),
	].filter(Boolean);
}
