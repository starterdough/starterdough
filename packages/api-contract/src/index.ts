import { z } from 'zod';
import {
	adminProcedure,
	controlCharacterRule,
	isPlainText,
	isSingleLine,
	protectedProcedure,
	publicProcedure,
} from './procedures';
import { productContract } from './product';

/**
 * API contract: the single source of truth consumed by every frontend
 * (SvelteKit web, Tauri desktop/mobile, CLI) and by non-TypeScript callers
 * through the generated OpenAPI document (`GET /api/v1/openapi.json`).
 *
 * Rules of the road:
 *  - Define shape + routing here, implement in `apps/api/src/rpc/router.ts`.
 *  - A product's procedures go in `./product.ts` (or a file it spreads in), never here: this file
 *    changes with every kit release, and that one never does.
 *  - Every procedure gets an explicit `route` so it is also a plain REST endpoint.
 *  - Auth-protected procedures extend `protectedProcedure` so `UNAUTHORIZED`/`FORBIDDEN`
 *    are typed on the client.
 */

// ── Shared schemas ─────────────────────────────────────────────────────────────

export const UserSchema = z.object({
	id: z.string(),
	email: z.email(),
	name: z.string(),
	image: z.string().nullable(),
	/** Set by the Better Auth admin plugin ("user" | "admin"). */
	role: z.string().nullable(),
	createdAt: z.date(),
});
export type User = z.infer<typeof UserSchema>;

export const SocialProviderSchema = z.enum(['github', 'google']);
export type SocialProvider = z.infer<typeof SocialProviderSchema>;

/** What the sign-in UI needs to know about this deployment's auth setup. */
export const AuthConfigSchema = z.object({
	/** Social providers with credentials configured on the server. */
	socialProviders: z.array(SocialProviderSchema),
	/** Whether sign-up ends with "check your inbox" instead of a session. */
	requireEmailVerification: z.boolean(),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// ── Admin schemas (platform administrators, Better Auth `user.role`) ───────────────────────────

/** Stable slug used literally in code (`flags['new-editor']`). */
export const FlagKeySchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use lowercase letters, numbers, dots, dashes and underscores');

export const FeatureFlagSchema = z.object({
	key: FlagKeySchema,
	description: z.string(),
	enabled: z.boolean(),
	createdAt: z.date(),
	updatedAt: z.date(),
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

/** Input shared by the admin form and `admin.flags.upsert`. */
export const FeatureFlagUpsertInputSchema = z.object({
	key: FlagKeySchema,
	description: z.string().max(200).refine(isSingleLine, controlCharacterRule).optional(),
	enabled: z.boolean().optional(),
});
export type FeatureFlagUpsertInput = z.infer<typeof FeatureFlagUpsertInputSchema>;

const ProbeSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number().nullable(),
	error: z.string().nullable(),
});

/** One migration history as the database has it: what this build ships against what ran. */
const MigrationHistoryStatusSchema = z.object({
	shipped: z.number().int(),
	applied: z.number().int(),
	pending: z.array(z.string()),
	unknown: z.number().int(),
	latestApplied: z.string().nullable(),
});

/** Everything `/admin/system` shows. Secrets never appear here, only what is configured. */
export const SystemStatusSchema = z.object({
	/** The product's `version` from the root `package.json`, the one `/health` reports too. */
	version: z.string(),
	/** The kit release (`kitVersion`). Only here: the public `/health` does not name it. */
	kitVersion: z.string(),
	environment: z.string(),
	runtime: z.string(),
	startedAt: z.iso.datetime(),
	uptimeSeconds: z.number().int(),
	counts: z.object({
		users: z.number().int(),
	}),
	database: ProbeSchema.extend({
		/** The kit's history (`packages/db/drizzle`) and the product's (`packages/db/drizzle-product`). */
		migrations: z
			.object({ kit: MigrationHistoryStatusSchema, product: MigrationHistoryStatusSchema })
			.nullable(),
	}),
	email: z.object({ provider: z.string(), from: z.string() }),
	auth: AuthConfigSchema,
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

// ── Public site ────────────────────────────────────────────────────────────────

/** Contact / waitlist form on the marketing site (`apps/site`). */
export const ContactInputSchema = z.object({
	email: z.email(),
	name: z.string().trim().max(120).refine(isSingleLine, controlCharacterRule).optional(),
	message: z.string().trim().min(10).max(2000).refine(isPlainText, controlCharacterRule),
	/** Honeypot, hidden in the form: bots fill it, people never see it. Non-empty → dropped. */
	website: z.string().max(200).optional(),
});
export type ContactInput = z.infer<typeof ContactInputSchema>;

// ── Contract ───────────────────────────────────────────────────────────────────

export const contract = {
	system: {
		health: publicProcedure
			.route({ method: 'GET', path: '/health', tags: ['system'], summary: 'Liveness probe' })
			.output(
				z.object({
					status: z.literal('ok'),
					version: z.string(),
					time: z.iso.datetime(),
				}),
			),

		authConfig: publicProcedure
			.route({
				method: 'GET',
				path: '/auth-config',
				tags: ['system'],
				summary: 'Sign-in methods enabled on this deployment',
			})
			.output(AuthConfigSchema),

		flags: protectedProcedure
			.route({
				method: 'GET',
				path: '/flags',
				tags: ['system'],
				summary: 'Feature flags for this deployment',
			})
			.output(z.record(FlagKeySchema, z.boolean())),
	},

	contact: {
		send: publicProcedure
			.route({
				method: 'POST',
				path: '/contact',
				tags: ['public'],
				summary: 'Message from the public contact / waitlist form (rate-limited per IP)',
			})
			.errors({
				PRECONDITION_FAILED: { message: 'The contact form is not configured on this deployment.' },
			})
			.input(ContactInputSchema)
			.output(z.object({ ok: z.literal(true) })),
	},

	admin: {
		flags: {
			list: adminProcedure
				.route({
					method: 'GET',
					path: '/admin/flags',
					tags: ['admin'],
					summary: 'All feature flags',
				})
				.output(z.array(FeatureFlagSchema)),

			upsert: adminProcedure
				.route({
					method: 'PUT',
					path: '/admin/flags/{key}',
					tags: ['admin'],
					summary: 'Create a feature flag or change its description / global default',
				})
				.input(FeatureFlagUpsertInputSchema)
				.output(FeatureFlagSchema),

			delete: adminProcedure
				.route({
					method: 'DELETE',
					path: '/admin/flags/{key}',
					tags: ['admin'],
					summary: 'Delete a feature flag',
				})
				.errors({ NOT_FOUND: { message: 'No such flag.' } })
				.input(z.object({ key: FlagKeySchema }))
				.output(z.object({ key: FlagKeySchema })),
		},

		system: {
			status: adminProcedure
				.route({
					method: 'GET',
					path: '/admin/system',
					tags: ['admin'],
					summary: 'Version, database and migrations, service health, configuration',
				})
				.output(SystemStatusSchema),
		},
	},

	account: {
		me: protectedProcedure
			.route({ method: 'GET', path: '/me', tags: ['account'], summary: 'Current user' })
			.output(UserSchema),
	},

	// Last, so that a product procedure cannot replace a kit one: a clash fails `bun run check`.
	...productContract,
};

export type Contract = typeof contract;
