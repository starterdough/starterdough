<script lang="ts">
	import { Button } from '@repo/ui';
	import { analytics } from '$lib/analytics.svelte';
	import { m } from '$lib/paraglide/messages';
</script>

<!-- Only when the deployment has analytics and the visitor has not decided yet. -->
{#if analytics.available && analytics.consent === 'undecided'}
	<section
		aria-label={m.public_consent_label()}
		class="bg-popover text-popover-foreground border-border fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-3 rounded-lg border p-4 shadow-lg sm:flex-row sm:items-center"
	>
		<p class="flex-1 text-sm">{m.public_consent_text()}</p>
		<div class="flex gap-2">
			<Button size="sm" onclick={() => analytics.decide('granted')}>
				{m.public_consent_accept()}
			</Button>
			<Button size="sm" variant="secondary" onclick={() => analytics.decide('denied')}>
				{m.public_consent_decline()}
			</Button>
		</div>
	</section>
{/if}
