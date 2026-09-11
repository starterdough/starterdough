<script lang="ts">
	import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { m } from '$lib/paraglide/messages';

	let { children } = $props();
</script>

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
	class="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-6 outline-none"
>
	<a class="text-muted-foreground w-fit text-sm font-semibold" href="/">{m.common_app_name()}</a>
	{@render children()}
</main>
