// ── Platform administrators (Better Auth `admin` plugin, `user.role`) ─────────────────────────
// The operator of the deployment. The same list is passed to `admin({ adminRoles })` on the
// server, checked by `requireAdmin` in the API router and used by the `/admin` route guard in
// the web app.

export const ADMIN_ROLES = ['admin'] as const;

/** Is this `user.role` value (possibly comma-separated) a platform administrator? */
export function isAdmin(role: string | null | undefined): boolean {
	if (!role) return false;
	return role
		.split(',')
		.map((r) => r.trim())
		.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
}
