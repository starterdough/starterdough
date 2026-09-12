<script lang="ts">
	import { Button } from '@repo/ui';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';

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
</script>

<svelte:head><title>{title} · {m.common_app_name()}</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col items-start justify-center gap-4 px-6">
	<p class="text-muted-foreground font-mono text-sm">{page.status}</p>
	<h1 class="text-2xl font-semibold">{title}</h1>
	<p class="text-muted-foreground text-sm">{description}</p>
	{#if page.error?.id && page.status !== 404}
		<p class="text-muted-foreground font-mono text-xs">
			{m.common_error_reference({ id: page.error.id })}
		</p>
	{/if}
	<div class="mt-2 flex gap-2">
		{#if page.status >= 500}
			<Button onclick={() => location.reload()}>{m.common_reload()}</Button>
			<Button href="/app" variant="secondary">{m.common_go_to_app()}</Button>
		{:else}
			<Button href="/app">{m.common_go_to_app()}</Button>
			<Button href="/" variant="secondary">{m.common_home()}</Button>
		{/if}
	</div>
</main>
