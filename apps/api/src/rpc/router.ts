import { authFeatures } from '@repo/auth/server';
import { effectiveFlags } from '@repo/db';
import { adminRouter } from './admin';
import { authed, os } from './base';
import { contactRouter } from './contact';
import { version } from './version';

export const router = os.router({
	system: {
		health: os.system.health.handler(() => ({
			status: 'ok' as const,
			version,
			time: new Date().toISOString(),
		})),

		authConfig: os.system.authConfig.handler(() => authFeatures),

		flags: authed.system.flags.handler(() => effectiveFlags()),
	},

	contact: contactRouter,

	admin: adminRouter,

	account: {
		me: authed.account.me.handler(({ context }) => {
			const { user } = context.session;
			return {
				id: user.id,
				email: user.email,
				name: user.name,
				image: user.image ?? null,
				role: (user as { role?: string | null }).role ?? null,
				createdAt: user.createdAt,
			};
		}),
	},
});

export type Router = typeof router;
