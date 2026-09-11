import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { ORPCError } from '@repo/api-client';
import { QueryClient } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { api } from './api';

/**
 * TanStack Query utilities derived from the typed API client — the query key, the fetcher and the
 * types come from the contract, so nothing is hand-written per procedure:
 *
 *   const flags = createQuery(() => orpc.admin.flags.list.queryOptions());
 *   const upsert = createMutation(() => orpc.admin.flags.upsert.mutationOptions({
 *     onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.admin.flags.key() }),
 *   }));
 *
 * `orpc.<router>.key()` is a partial key for invalidation, `.queryKey({ input })` a full one.
 */
export const orpc = createTanstackQueryUtils(api);

/** oRPC turns 4xx answers into `ORPCError`s with a status; retrying those cannot help. */
function retry(failureCount: number, error: unknown) {
	if (error instanceof ORPCError && error.status < 500) return false;
	return failureCount < 2;
}

let browserClient: QueryClient | undefined;

/**
 * The QueryClient for the current page (root `+layout.ts`). One per browser session — the layout
 * load re-runs on `invalidateAll()` and must not wipe the cache — and one per request on the
 * server. Queries are disabled during SSR: they would run with the server's plain `fetch` (no
 * session cookie). Pages that need data in the HTML fetch it in `load` with `apiFor(fetch)`.
 */
export function getQueryClient(): QueryClient {
	if (!browser) return createQueryClient();
	browserClient ??= createQueryClient();
	return browserClient;
}

function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { enabled: browser, staleTime: 30_000, retry },
			mutations: { retry: false },
		},
	});
}
