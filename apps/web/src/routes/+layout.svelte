<script lang="ts">
	import './layout.css';
	// Deep imports, not the barrel: the landing page pays for whatever the root layout pulls in, and
	// the barrel is every component in the library.
	import { Toaster } from '@repo/ui/components/ui/sonner/index.js';
	import { TooltipProvider } from '@repo/ui/components/ui/tooltip/index.js';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { analytics } from '$lib/analytics.svelte';
	import { API_URL, DEMO_MODE } from '$lib/api';
	import favicon from '$lib/assets/favicon.svg';
	import ConsentBanner from '$lib/components/ConsentBanner.svelte';
	import { applyZodLocale, syncDocumentLocale } from '$lib/i18n';
	import { pwa } from '$lib/pwa.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	onMount(() => {
		// Locale: hooks.server.ts set <html lang> for SSR; the static SPA shell needs it done here.
		syncDocumentLocale();
		void applyZodLocale();
		pwa.start();
		analytics.start();
	});

	afterNavigate(() => analytics.page());
</script>

<svelte:head>
	<link rel="icon" href={favicon}>
	<!--
		The API is a separate origin on every deployment but the single-origin one, so the first call
		the browser makes after hydration pays a fresh DNS + TCP + TLS handshake on top of the round
		trip, measured at ~300 ms from a desk in the US to the German VPS, because two hosts with
		one SAN each cannot share a connection. Opening it during head parse overlaps that with
		rendering instead of queueing it behind hydration.

		`crossorigin` is load-bearing, not decoration: every call this app makes is
		`credentials: 'include'`, and a connection opened anonymously is not reused for credentialed
		requests; the preconnect would warm a socket nothing touches. A same-origin deployment
		dedupes this against the connection it already has, so there is nothing to guard.
	-->
	<link rel="preconnect" href={API_URL} crossorigin="use-credentials">
	{#if DEMO_MODE}
		<!-- A public demo must not outrank the product site in search results. -->
		<meta name="robots" content="noindex, nofollow">
	{/if}
</svelte:head>

<!--
	Light/dark: `.light`/`.dark` on <html>, persisted; "system" follows the OS (see @repo/ui/theme.css).

	`disableHeadScriptInjection`: mode-watcher otherwise writes the class from an inline <script> in
	<head>, which only 'unsafe-inline' in `script-src` allows, and a hash cannot replace it, because
	the script is `setInitialMode.toString()` from the *bundled* module, which the bundler reformats
	(measured: tabs in the output, four spaces in the package), so any hash computed from the shipped
	source is wrong and fails silently. Dropping it costs nothing for the default "system" mode: the
	tokens are `light-dark()` pairs under `color-scheme: light dark`, so an unclassed document already
	follows the OS. Only a visitor who forced the mode *against* their OS sees one frame of the other
	theme before hydration.
-->
<ModeWatcher lightClassNames={['light']} darkClassNames={['dark']} disableHeadScriptInjection />

<!-- `Tooltip.Root` reads a context this provider sets and throws without it: a 500 during SSR. -->
<TooltipProvider delayDuration={200}>
	<QueryClientProvider client={data.queryClient}>{@render children()}</QueryClientProvider>
</TooltipProvider>

<Toaster position="bottom-right" closeButton />
<ConsentBanner />
