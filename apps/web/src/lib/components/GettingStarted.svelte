<script lang="ts">
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import { cn } from '@repo/ui';
	import { toast } from 'svelte-sonner';
	import { returnUrl } from '#lib/api.js';
	import { authClient } from '#lib/auth.js';
	import { type GettingStartedStep, stepProgress } from '#lib/home.js';
	import { m } from '#lib/paraglide/messages.js';

	let { steps }: { steps: GettingStartedStep[] } = $props();

	const progress = $derived(stepProgress(steps));

	// The one step done from the list itself: sending the verification email again.
	let resend = $state<'idle' | 'sending' | 'sent'>('idle');

	async function resendVerification(email: string) {
		resend = 'sending';
		const result = await authClient.sendVerificationEmail({
			email,
			callbackURL: returnUrl('/verify-email'),
		});
		if (result.error) {
			resend = 'idle';
			toast.error(result.error.message ?? m.app_home_step_verify_error());
			return;
		}
		resend = 'sent';
	}
</script>

<section class="border-border rounded-lg border p-6" aria-labelledby="getting-started-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h2 id="getting-started-heading" class="text-lg font-semibold">
			{m.app_home_checklist_title()}
		</h2>
		<p class="text-muted-foreground text-sm">
			{m.app_home_checklist_progress({ done: progress.done, total: progress.total })}
		</p>
	</div>
	<ol class="divide-border mt-4 flex flex-col divide-y">
		{#each steps as step (step.id)}
			{@const action = step.action}
			<li class="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
				{#if step.done}
					<CircleCheckIcon class="text-success mt-0.5 size-5 shrink-0" aria-hidden="true" />
				{:else}
					<CircleIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
				{/if}
				<!-- The action sits under the text on a phone and beside it from `sm` up. -->
				<div
					class="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
				>
					<div class="min-w-0">
						<p class={cn('font-medium', step.done && 'text-muted-foreground')}>
							{step.title}
							<span class="sr-only">
								({step.done ? m.app_home_step_done() : m.app_home_step_todo()})
							</span>
						</p>
						{#if !step.done}
							<p class="text-muted-foreground text-sm">{step.description}</p>
						{/if}
					</div>
					{#if !step.done}
						{#if 'href' in action}
							<a class="shrink-0 text-sm font-medium underline" href={action.href}
								>{action.label}</a
							>
						{:else if resend === 'sent'}
							<p class="text-muted-foreground shrink-0 text-sm" role="status">
								{m.app_home_step_verify_sent()}
							</p>
						{:else}
							<button
								type="button"
								class="shrink-0 self-start text-sm font-medium underline disabled:opacity-50"
								disabled={resend === 'sending'}
								onclick={() => void resendVerification(action.resendVerificationTo)}
							>
								{resend === 'sending' ? m.common_sending() : action.label}
							</button>
						{/if}
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</section>
