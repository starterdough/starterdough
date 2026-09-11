import { implement, ORPCError } from '@orpc/server';
import { contract } from '@repo/api-contract';
import { isAdmin } from '@repo/auth/permissions';
import { auth } from '@repo/auth/server';
import type { Context } from './context';

export const os = implement(contract).$context<Context>();

/** The session behind the cookie or bearer token, or `UNAUTHORIZED`. */
async function resolveSession(headers: Headers) {
	const session = await auth.api.getSession({ headers });
	if (!session) throw new ORPCError('UNAUTHORIZED');
	return session;
}

/** Rejects anonymous callers; adds `session` to the context. */
export const requireAuth = os.middleware(async ({ context, next }) => {
	const session = await resolveSession(context.headers);
	return next({ context: { session } });
});

export const authed = os.use(requireAuth);

/**
 * Platform administrators only (`user.role`, see `@repo/auth/permissions` → `isAdmin`). The
 * Better Auth `/admin/*` endpoints check the same role list; this covers our own procedures.
 */
export const requireAdmin = os.middleware(async ({ context, next }) => {
	const session = await resolveSession(context.headers);
	if (!isAdmin((session.user as { role?: string | null }).role)) throw new ORPCError('FORBIDDEN');
	return next({ context: { session } });
});

export const adminOnly = os.use(requireAdmin);

/**
 * A Postgres unique violation (`23505`) as it arrives through Drizzle, which wraps every failure in
 * a `DrizzleQueryError` and keeps the driver's error as `cause`.
 *
 * A procedure that pre-checks uniqueness still loses the race sometimes; the index is what actually
 * enforces it, and its violation must surface as the `CONFLICT` the contract declares, not a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { cause } = error as { cause?: unknown };
	if (typeof cause !== 'object' || cause === null) return false;
	return (cause as { code?: unknown }).code === '23505';
}
