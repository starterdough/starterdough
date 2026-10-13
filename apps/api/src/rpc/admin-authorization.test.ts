import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { call } from '@orpc/server';
import { auth, type Session } from '@repo/auth/server';
import * as db from '@repo/db';
import pkg from '../../../../package.json';
import { adminRouter } from './admin';

// Exercise the real middleware and handler wiring. Only session lookup is replaced, and the spy
// is restored so the full API suite keeps its real authentication module in any test-file order.
const now = new Date();
const session: Session = {
	user: {
		id: 'member_1',
		name: 'Member',
		email: 'member@example.invalid',
		emailVerified: true,
		createdAt: now,
		updatedAt: now,
		role: 'user',
		banned: false,
		twoFactorEnabled: false,
	},
	session: {
		id: 'session_1',
		userId: 'member_1',
		token: 'synthetic-test-session',
		createdAt: now,
		updatedAt: now,
		expiresAt: new Date(now.getTime() + 60_000),
	},
};

afterEach(() => {
	mock.restore();
});

describe('admin authorization', () => {
	it('refuses an authenticated non-admin before the flags handler reaches the database', async () => {
		const lookup = spyOn(auth.api, 'getSession').mockResolvedValue(session);
		try {
			await expect(
				call(adminRouter.flags.list, undefined, { context: { headers: new Headers() } }),
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
		} finally {
			lookup.mockRestore();
		}
	});
});

describe('system status', () => {
	it('names the kit release next to the product version', async () => {
		spyOn(auth.api, 'getSession').mockResolvedValue({
			...session,
			user: { ...session.user, role: 'admin' },
		});
		// Every probe fails at once instead of reaching for Postgres or another service; the status
		// reports each as down, and the versions do not depend on them.
		const offline = new Error('offline');
		spyOn(db, 'pingDatabase').mockRejectedValue(offline);
		spyOn(db, 'platformCounts').mockRejectedValue(offline);

		const status = await call(adminRouter.system.status, undefined, {
			context: { headers: new Headers() },
		});
		expect(status.kitVersion).toBe(pkg.kitVersion);
		expect(status.version).toBe(pkg.version);
		expect(status.database.ok).toBe(false);
	});
});
