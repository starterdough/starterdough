<script lang="ts">
	import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { m } from '$lib/paraglide/messages';

	const primaryLink =
		'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none';
	const secondaryLink =
		'bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none';
</script>

<svelte:head><title>{m.common_app_name()}</title></svelte:head>

<a
	href="#main"
	class="focus:bg-primary focus:text-primary-foreground focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-offset-2 focus:outline-none"
>
	{m.common_skip_to_content()}
</a>

<div class="absolute top-4 right-4 flex items-center gap-1">
	<LocaleSwitcher compact />
	<ThemeToggle compact />
</div>

<main
	id="main"
	tabindex="-1"
	class="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-6 px-6 outline-none"
>
	<h1 class="text-4xl font-semibold tracking-tight">{m.common_app_name()}</h1>
	<p class="text-muted-foreground text-lg">{m.public_landing_description()}</p>
	<div class="flex gap-3">
		<a href="/app" class={primaryLink}>{m.common_open_app()}</a>
		<a href="/login" class={secondaryLink}>{m.common_sign_in()}</a>
	</div>
</main>
