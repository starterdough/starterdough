import type { SystemStatus } from '@repo/api-contract';
import { authFeatures } from '@repo/auth/server';
import {
	deleteFlag,
	listFlags,
	migrationStatus,
	pingDatabase,
	platformCounts,
	upsertFlag,
} from '@repo/db';
import { email } from '@repo/email';
import { env } from '@repo/env';
import { adminOnly } from './base';
import { startedAt, version } from './version';

/**
 * Platform-admin procedures (`/admin/*` in the REST surface). User management (search, ban,
 * roles, impersonation) is Better Auth's admin plugin at `/api/auth/admin/*`; these cover what
 * the plugin does not know about: feature flags and system health.
 */

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function probeDatabase(): Promise<SystemStatus['database']> {
	try {
		const latencyMs = await pingDatabase();
		const migrations = await migrationStatus();
		return { ok: true, latencyMs, error: null, migrations };
	} catch (error) {
		return { ok: false, latencyMs: null, error: errorMessage(error), migrations: null };
	}
}

export const adminRouter = {
	flags: {
		list: adminOnly.admin.flags.list.handler(() => listFlags()),

		upsert: adminOnly.admin.flags.upsert.handler(async ({ input }) => {
			const flag = await upsertFlag(input);
			return flag;
		}),

		delete: adminOnly.admin.flags.delete.handler(async ({ input, errors }) => {
			if (!(await deleteFlag(input.key))) throw errors.NOT_FOUND();
			return { key: input.key };
		}),
	},

	system: {
		status: adminOnly.admin.system.status.handler(async () => {
			const [counts, database] = await Promise.all([
				platformCounts().catch(() => ({ users: 0 })),
				probeDatabase(),
			]);
			return {
				version,
				environment: env.NODE_ENV,
				runtime: `bun ${Bun.version}`,
				startedAt: startedAt.toISOString(),
				uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
				counts,
				database,
				email: { provider: email.name, from: env.EMAIL_FROM },
				auth: authFeatures,
			};
		}),
	},
};
