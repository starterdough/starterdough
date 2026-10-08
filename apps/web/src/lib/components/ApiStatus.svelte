<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { formatDateTime } from '#lib/i18n.js';
	import { m } from '#lib/paraglide/messages.js';
	import { orpc } from '#lib/query.js';

	// The same typed client everywhere (web, desktop, mobile), as a query, so the API is probed
	// from the browser only: during SSR this would block the response on a round trip that the
	// browser repeats anyway, and would fail the static build outright.
	const health = createQuery(() => orpc.system.health.queryOptions());
</script>

<footer class="text-muted-foreground mt-12 text-xs" aria-live="polite">
	{#if health.data}
		{m.app_home_api_status({
			version: health.data.version,
			time: formatDateTime(health.data.time),
		})}
	{:else if health.isError}
		{m.app_home_api_unreachable()}
	{/if}
</footer>
