import { getQueryClient } from '$lib/query';
import type { LayoutLoad } from './$types';

/**
 * The static build (Tauri desktop/mobile shells) runs as a pure single-page app;
 * every other target server-renders. `ADAPTER` is injected by vite.config.ts.
 */
export const ssr = import.meta.env.ADAPTER !== 'static';

/** The TanStack QueryClient is provided from here so every route shares one cache. */
export const load: LayoutLoad = () => ({ queryClient: getQueryClient() });
