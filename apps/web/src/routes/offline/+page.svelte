<script lang="ts">
	import { Button } from '@repo/ui';
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head><title>{m.public_offline_title()} · {m.common_app_name()}</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col items-start justify-center gap-4 px-6">
	<h1 class="text-2xl font-semibold">{m.public_offline_title()}</h1>
	<p class="text-muted-foreground text-sm">{m.public_offline_description()}</p>
	<Button onclick={() => location.reload()}>{m.common_try_again()}</Button>
</main>
