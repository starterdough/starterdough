import type { FetchLike } from '@repo/api-client';
import { authFor } from '$lib/auth';

/**
 * The session as page data: only the fields the shell and the guards render. Better Auth's own
 * payload also carries `session.token`, which its bearer plugin accepts as a credential — that
 * value must never reach the HTML, so nothing here copies it and `hooks.server.ts` strips it from
 * the response SvelteKit inlines for hydration (`sessionPayloadWithoutToken`).
 */
export interface PageSession {
	user: {
		id: string;
		email: string;
		emailVerified: boolean;
		/** Platform role (Better Auth admin plugin), not an organization role. */
		role: string | null;
		/**
		 * Profile fields the account pages render. None is a credential; they are here so
		 * `/app/settings` and `/app/settings/security` render complete instead of filling in a
		 * round trip after hydration.
		 */
		name: string;
		image: string | null;
		twoFactorEnabled: boolean;
	};
	session: {
		/**
		 * Row id, not `token`. `/app/settings/sessions` marks "this device" with it; the token that
		 * would also identify the session is a bearer credential and never leaves the API.
		 */
		id: string;
		activeOrganizationId: string | null;
		/** Set while an administrator is signed in as this user. */
		impersonatedBy: string | null;
	};
}

/**
 * Why there is no session. `signed_out` is an answer from the API (no cookie, an expired or
 * revoked session); `unreachable` is no answer at all — a dead network, a stopped API, a 5xx.
 * The guards treat them differently: one is a sign-in prompt, the other an outage. Bouncing an
 * outage to `/login` loses the user's place and offers a form that cannot work either.
 */
export type NoSessionReason = 'signed_out' | 'unreachable';

export interface SessionResult {
	session: PageSession | null;
	/** Only set when `session` is `null`. */
	reason: NoSessionReason | null;
}

/**
 * Classify a failed session lookup. Better Auth answers a missing or expired session with a 4xx;
 * anything else — no `status` at all (the fetch threw), or a 5xx — means the API did not answer.
 */
export function noSessionReason(error: { status?: number } | null | undefined): NoSessionReason {
	const status = error?.status ?? 0;
	return status >= 400 && status < 500 ? 'signed_out' : 'unreachable';
}

/**
 * The current session as the API sees it, with why it is missing. Never throws.
 *
 * Pass SvelteKit's `fetch` from `load` so SSR forwards the browser's cookies (hooks.server.ts).
 */
export async function sessionResult(fetch: FetchLike): Promise<SessionResult> {
	const result = await authFor(fetch)
		.getSession()
		.catch(() => ({ data: null, error: { status: 0 } }));
	const session = sessionFrom(result.data);
	if (session) return { session, reason: null };
	// A clean 200 with no session is a plain sign-out; `error` is what says otherwise.
	const error = (result as { error?: { status?: number } | null }).error;
	return { session: null, reason: error ? noSessionReason(error) : 'signed_out' };
}

/** The session, or `null` for any reason at all. */
export async function sessionFor(fetch: FetchLike): Promise<PageSession | null> {
	return (await sessionResult(fetch)).session;
}

type SessionPayload = Awaited<ReturnType<ReturnType<typeof authFor>['getSession']>>['data'];

function sessionFrom(data: SessionPayload): PageSession | null {
	if (!data) return null;
	return {
		user: {
			id: data.user.id,
			email: data.user.email,
			emailVerified: data.user.emailVerified,
			role: data.user.role ?? null,
			name: data.user.name,
			image: data.user.image ?? null,
			// Declared by the twoFactor plugin; absent until the user has ever enrolled.
			twoFactorEnabled: data.user.twoFactorEnabled === true,
		},
		session: {
			id: data.session.id,
			activeOrganizationId: data.session.activeOrganizationId ?? null,
			// Declared by the impersonation plugin, absent from the client's inferred session type.
			impersonatedBy: (data.session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
		},
	};
}

/**
 * `payload` without `session.token`. The session endpoint answers with the whole session row, and
 * SvelteKit inlines every response an SSR `load` fetched into the page so the browser does not
 * repeat the request — which would publish a working 7-day bearer credential in the HTML (and in
 * anything that caches it). Web builds authenticate with the httpOnly cookie and never need it;
 * the static build has no SSR. Any other shape is returned unchanged.
 */
export function sessionPayloadWithoutToken(payload: unknown): unknown {
	if (!payload || typeof payload !== 'object') return payload;
	const session = (payload as { session?: unknown }).session;
	if (!session || typeof session !== 'object' || !('token' in session)) return payload;
	const { token: _token, ...rest } = session as Record<string, unknown>;
	return { ...(payload as Record<string, unknown>), session: rest };
}
