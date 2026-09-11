import { type FetchLike, safe } from '@repo/api-client';
import { page } from '$app/state';
import { apiFor } from '$lib/api';

/** Resolved feature flags: key → enabled, at their global defaults. */
export type Flags = Record<string, boolean>;

/**
 * The global feature flags. Fetched once per session in the `(app)` layout load and exposed as
 * `page.data.flags`. Never throws: an unreachable API means "nothing is on", which is the safe
 * default for a gated feature.
 */
export async function flagsFor(fetch: FetchLike): Promise<Flags> {
	const [error, flags] = await safe(apiFor(fetch).system.flags({}));
	return error ? {} : flags;
}

/**
 * Reactive read for components: `{#if flag('new-editor')}`. Keys are the ones created on
 * `/admin/flags`; an unknown key is simply off.
 */
export function flag(key: string): boolean {
	return page.data.flags?.[key] === true;
}
