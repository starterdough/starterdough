import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@repo/api-contract';

export { consumeEventIterator, isDefinedError, ORPCError, safe } from '@orpc/client';
export type {
	AuthConfig,
	Contract,
	FeatureFlag,
	SocialProvider,
	SystemStatus,
	User,
} from '@repo/api-contract';
export { FlagKeySchema } from '@repo/api-contract';

/** Fully typed client: `await api.account.me()`. */
export type ApiClient = ContractRouterClient<Contract>;

/** Anything shaped like `fetch` (browser, Bun, SvelteKit's per-request `fetch`). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
	/** Origin of the API, e.g. `https://api.example.com` or `http://localhost:3000`. */
	baseUrl: string;
	/**
	 * Bearer token source for environments without cookies (Tauri desktop/mobile, CLI).
	 * Browsers on the same site can leave this undefined and rely on the session cookie.
	 */
	getToken?: () => string | null | undefined | Promise<string | null | undefined>;
	/** Custom fetch: pass SvelteKit's `fetch` from `load` so SSR forwards cookies. */
	fetch?: FetchLike;
	/** Defaults to `include` so the session cookie travels to the API origin. */
	credentials?: RequestCredentials;
	/** Static headers added to every request (e.g. an app version). */
	headers?: Record<string, string>;
}

/**
 * Create a client bound to one API origin.
 *
 * Transport: oRPC's RPC link over `POST {baseUrl}/rpc/...`. The same router is also
 * exposed as plain REST under `{baseUrl}/api/v1` for Python services, curl and third parties.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
	const baseUrl = options.baseUrl.replace(/\/+$/, '');
	const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

	const link = new RPCLink({
		url: `${baseUrl}/rpc`,
		headers: async () => {
			const token = await options.getToken?.();
			return {
				...options.headers,
				...(token ? { authorization: `Bearer ${token}` } : {}),
			};
		},
		fetch: (request, init) =>
			fetchImpl(request, { ...init, credentials: options.credentials ?? 'include' }),
	});

	return createORPCClient(link);
}
