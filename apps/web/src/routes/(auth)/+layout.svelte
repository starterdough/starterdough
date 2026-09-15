<script lang="ts">
	import { Card } from '@repo/ui';
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

<!--
	The forms sit in a card rather than loose on the page: an unbounded column of inputs on a wide
	viewport reads as debris, and the card gives the eye an edge to find them by. `min-h-screen`
	rather than `h-screen`, so the tall pages (sign-up, an invitation) grow past the fold and scroll
	instead of centring their own top out of reach.

	The wordmark is a label, not a link: `/` redirects into the app (`src/routes/+page.ts`), which
	sends a visitor without a session straight back here.

	`shadow-sm` earns its place in the light theme only, where `--card` and `--background` are both
	white and the ring alone is a hairline; in the dark theme the card is already a lighter grey
	than the page and a shadow on it is invisible either way.
-->
<main
	id="main"
	tabindex="-1"
	class="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6 py-12 outline-none"
>
	<p class="text-muted-foreground text-sm font-semibold">{m.common_app_name()}</p>
	<Card.Root class="[--card-spacing:--spacing(6)] shadow-sm">
		<Card.Content class="flex flex-col gap-5"> {@render children()} </Card.Content>
	</Card.Root>
</main>
