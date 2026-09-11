<script lang="ts">
	// No tenancy in the free edition, so /app is simply where a signed-in visitor lands.
	import { m } from '$lib/paraglide/messages';
</script>

<svelte:head><title>{m.common_home()} · {m.common_app_name()}</title></svelte:head>

<h1 class="text-2xl font-semibold">{m.common_home()}</h1>
