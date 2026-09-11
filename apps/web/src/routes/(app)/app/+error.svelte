<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LockIcon from '@lucide/svelte/icons/lock';
	import { Button } from '@repo/ui';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';

	// Rendered inside the app shell for anything under /app; unexpected failures arrive with the
	// reference id that `handleError` attached.
	const title = $derived(
		page.status === 404
			? m.common_error_not_found_title()
			: page.status === 403
				? m.common_error_forbidden_title()
				: (page.error?.message ?? m.common_error_generic()),
	);
	const description = $derived(
		page.status === 404
			? m.common_error_not_found_description()
			: page.status === 403
				? m.common_error_forbidden_description()
				: // 503: the route guards answer with this when the API did not answer at all.
					page.status === 503
					? m.common_api_unreachable_description()
					: m.common_error_generic_description(),
	);
	const expected = $derived(page.status === 404 || page.status === 403);
</script>

<svelte:head><title>{title} · {m.common_app_name()}</title></svelte:head>

<div class="mx-auto flex w-full max-w-lg flex-col items-center gap-3 py-16 text-center">
	<div
		class="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full [&_svg]:size-6"
		aria-hidden="true"
	>
		{#if page.status === 404}
			<FolderOpenIcon />
		{:else if page.status === 403}
			<LockIcon />
		{:else}
			<CircleAlertIcon />
		{/if}
	</div>
	<p class="text-muted-foreground font-mono text-sm">{page.status}</p>
	<h1 class="text-2xl font-semibold">{title}</h1>
	<p class="text-muted-foreground max-w-md text-sm">{description}</p>
	{#if page.error?.id && !expected}
		<p class="text-muted-foreground font-mono text-xs">
			{m.common_error_reference({ id: page.error.id })}
		</p>
	{/if}
	<div class="mt-3 flex flex-wrap justify-center gap-2">
		{#if expected}
			<Button href="/app">{m.common_go_to_app()}</Button>
		{:else}
			<Button onclick={() => location.reload()}>{m.common_reload()}</Button>
			<Button href="/app" variant="secondary">{m.common_go_to_app()}</Button>
		{/if}
	</div>
</div>
