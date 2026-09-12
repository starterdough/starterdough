import { passkey } from '@better-auth/passkey';
import { db } from '@repo/db';
import * as schema from '@repo/db/schema';
import { email, templates } from '@repo/email';
import { env, isProduction, trustedOrigins } from '@repo/env';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, bearer, openAPI, twoFactor } from 'better-auth/plugins';
import { ADMIN_ROLES } from './permissions';

const APP_NAME = 'Starterdough';

/**
 * Longest display name we store. Better Auth types it as a bare `z.string()`, so without a cap
 * a name is unbounded free text, and it is interpolated into email subjects and bodies
 * (`packages/email` escapes it; this keeps it a name).
 */
const MAX_NAME_LENGTH = 100;

/**
 * Normalise a display name: trim, drop the control, format and bidi code points that make a name
 * render as something it is not, collapse whitespace, and cut it to `MAX_NAME_LENGTH`. Returns
 * `undefined` when the input was not a string, so a hook can leave the field alone.
 */
function normalizeName(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const cleaned = value
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** `beforeCreate`/`beforeUpdate` shape for anything with an optional `name`. */
function withNormalizedName<T extends { name?: unknown }>(record: T): { data: T } | undefined {
	const name = normalizeName(record.name);
	if (name === undefined || name === record.name) return undefined;
	return { data: { ...record, name } };
}

/**
 * The client IP Better Auth rate-limits on and records on sessions. The API sets this header on
 * every `/api/auth/*` request from its own rule (socket address, or `X-Forwarded-For` when
 * `TRUST_PROXY=true`), replacing any client-supplied value, so it is never spoofable and both
 * limiters agree. Better Auth itself only reads headers and cannot see the socket.
 */
export const CLIENT_IP_HEADER = 'x-starterdough-client-ip';

const webUrl = env.WEB_URL;
const requireEmailVerification = env.REQUIRE_EMAIL_VERIFICATION ?? isProduction;

export type SocialProvider = 'github' | 'google';

/**
 * Which optional sign-in methods this deployment has configured. Served to every client
 * through the `system.authConfig` procedure so the UI never guesses from its own env.
 */
export const authFeatures: {
	socialProviders: SocialProvider[];
	requireEmailVerification: boolean;
} = {
	socialProviders: [
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? (['github'] as const) : []),
		...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? (['google'] as const) : []),
	],
	requireEmailVerification,
};

/**
 * The one and only auth server. It lives in the API process; every frontend talks
 * to it over HTTP at `${API_URL}/api/auth/*`.
 *
 * Session transport:
 *   - Browsers on the same site → httpOnly cookie (cross-subdomain when COOKIE_DOMAIN is set)
 *   - Tauri desktop/mobile, CLI → bearer token (the `bearer` plugin returns it in `set-auth-token`)
 *
 * Every email goes through `@repo/email` (console in development, Resend when configured).
 * The `url` Better Auth hands us already carries the token and the client's `callbackURL`.
 */
export const auth = betterAuth({
	appName: APP_NAME,
	baseURL: env.API_URL,
	basePath: '/api/auth',
	secret: env.BETTER_AUTH_SECRET,

	database: drizzleAdapter(db, { provider: 'pg', schema }),

	trustedOrigins: trustedOrigins(),

	emailAndPassword: {
		enabled: true,
		requireEmailVerification,
		revokeSessionsOnPasswordReset: true,
		async sendResetPassword({ user, url }) {
			await email.send({ to: user.email, ...templates.resetPassword({ name: user.name, url }) });
		},
	},

	emailVerification: {
		// Always send on sign-up so unverified accounts can be nudged even when not required.
		sendOnSignUp: true,
		// The link signs the user in, so it stays on Better Auth's 1 h expiry; the UI offers "resend".
		autoSignInAfterVerification: true,
		async sendVerificationEmail({ user, url }) {
			await email.send({ to: user.email, ...templates.verifyEmail({ name: user.name, url }) });
		},
	},

	user: {
		changeEmail: {
			enabled: true,
			// Approval goes to the *current* address; Better Auth then verifies the new one.
			async sendChangeEmailConfirmation({ user, newEmail, url }) {
				await email.send({
					to: user.email,
					...templates.changeEmailConfirmation({ name: user.name, newEmail, url }),
				});
			},
		},
		deleteUser: {
			enabled: true,
			// With a verification sender configured, deletion only happens after the emailed link is used.
			async sendDeleteAccountVerification({ user, url }) {
				await email.send({ to: user.email, ...templates.deleteAccount({ name: user.name, url }) });
			},
		},
	},

	socialProviders: {
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
			: {}),
		...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
			: {}),
	},

	rateLimit: {
		// Per client IP (`CLIENT_IP_HEADER`, set by the API). Built-in rules already throttle
		// sign-in/up and password/email changes (3 per 10 s) and reset/verification mails (3 per 60 s);
		// the two-factor plugin brings its own. Memory storage is right for one API container;
		// switch to `storage: 'database'` (then regenerate the schema) when running several replicas.
		enabled: isProduction,
		storage: 'memory',
		customRules: {
			'/passkey/*': { window: 60, max: 10 },
			'/delete-user': { window: 60, max: 3 },
		},
	},

	advanced: {
		// Only the API-set header counts; a bare `x-forwarded-for` would be a client's choice.
		ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
		crossSubDomainCookies: env.COOKIE_DOMAIN
			? { enabled: true, domain: env.COOKIE_DOMAIN }
			: { enabled: false },
	},

	databaseHooks: {
		// A display name is interpolated into every email we send and shown wherever the account
		// appears, and Better Auth types it as an uncapped `z.string()`. Normalise it at the one
		// place both sign-up and profile updates go through, rather than at each caller.
		user: {
			create: { before: async (user) => withNormalizedName(user) },
			update: { before: async (user) => withNormalizedName(user) },
		},
	},

	hooks: {
		// `disableDefaultReference` 404s the Scalar page but not the generator behind it, and that
		// route regenerates ~187 KB of JSON per unauthenticated request, outside the API's own
		// limiter. In production neither exists.
		before: createAuthMiddleware(async (ctx) => {
			if (isProduction && ctx.path === '/open-api/generate-schema') {
				throw new APIError('NOT_FOUND');
			}
		}),
	},

	plugins: [
		/**
		 * Platform administrators (`user.role`). `/admin/*` endpoints (list/ban/impersonate users,
		 * set roles) are gated by `adminRoles`; our own admin procedures use the same list through
		 * `isAdmin()` (permissions.ts). Bootstrap the first one with
		 * `bun run admin:create -- --email … --password …`.
		 */
		admin({
			adminRoles: [...ADMIN_ROLES],
			// Impersonation sessions are short on purpose; the admin cookie is restored on stop.
			impersonationSessionDuration: 60 * 60,
			bannedUserMessage:
				'This account has been suspended. Contact support if you think this is a mistake.',
		}),
		bearer(),
		twoFactor({ issuer: APP_NAME }),
		passkey({
			rpID: new URL(webUrl).hostname,
			rpName: APP_NAME,
			// Every origin the app is served from (web, Tauri shells, tailnet hosts).
			origin: trustedOrigins(),
		}),
		// Scalar reference + its generator: development only (see `hooks.before`).
		openAPI({ disableDefaultReference: isProduction }),
	],
});

export type Auth = typeof auth;
export type Session = Auth['$Infer']['Session'];
