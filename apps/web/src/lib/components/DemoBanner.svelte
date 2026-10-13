<script lang="ts">
	import { Alert } from '@repo/ui';
	import { DEMO_CTA_URL } from '#lib/api.js';
	import { m } from '#lib/paraglide/messages.js';

	/**
	 * The public demo's banner. Its link goes where `PUBLIC_DEMO_CTA_URL` says (your pricing page),
	 * and there is no link while that is empty: the kit names no seller here.
	 */
	let { href = DEMO_CTA_URL }: { href?: string | null } = $props();
</script>

<Alert class="mb-6">
	{m.shell_banner_demo_text()}
	{#if href}
		<a class="font-medium underline" {href}>{m.shell_banner_demo_link()}</a>
	{/if}
</Alert>
