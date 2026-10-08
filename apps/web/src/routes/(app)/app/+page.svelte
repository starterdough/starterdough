<script lang="ts">
	// No tenancy in the free edition, so /app is where a signed-in visitor lands: who they are,
	// what is left to set up on the account, and, in development, where to build from here.
	import { authClient } from '#lib/auth.js';
	import ApiStatus from '#lib/components/ApiStatus.svelte';
	import BuildNext from '#lib/components/BuildNext.svelte';
	import GettingStarted from '#lib/components/GettingStarted.svelte';
	import { accountSteps, greetingName, stepProgress } from '#lib/home.js';
	import { m } from '#lib/paraglide/messages.js';
	import { dev } from '$app/env';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Seeded by the layout load (so SSR has it), kept live by the client afterwards: verifying the
	// address or turning on two-factor authentication ticks its step without a reload.
	const session = authClient.useSession();
	const user = $derived($session.data?.user ?? data.session.user);
	const name = $derived(greetingName(user.name));
	// Shown until every step is done: a set-up account has no use for the list.
	const steps = $derived(accountSteps(user, data.passkeys));
	const gettingStarted = $derived(!stepProgress(steps).complete);
</script>

<svelte:head><title>{m.common_home()} · {m.common_app_name()}</title></svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-semibold">
			{name ? m.app_home_welcome_name({ name }) : m.app_home_welcome()}
		</h1>
		<p class="text-muted-foreground mt-1 text-sm">
			{m.app_home_signed_in_as({ email: user.email })}
		</p>
	</div>

	{#if gettingStarted}
		<GettingStarted {steps} />
	{/if}

	{#if dev}
		<BuildNext />
	{/if}
</div>

<ApiStatus />
