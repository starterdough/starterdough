import { describe, expect, it, spyOn } from 'bun:test';
import { call } from '@orpc/server';
import { auth, type Session } from '@repo/auth/server';
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
