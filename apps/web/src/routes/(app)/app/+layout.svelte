<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import { isAdmin } from '@repo/auth/permissions';
	import { Alert, Button, cn, Sheet } from '@repo/ui';
	import { onMount, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { analytics } from '$lib/analytics.svelte';
	import { authClient } from '$lib/auth';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { m } from '$lib/paraglide/messages';
	import { pwa } from '$lib/pwa.svelte';
	import { tokenStore } from '$lib/token-store';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// Seeded by the layout load (so SSR has it), kept live by the client afterwards.
	const session = authClient.useSession();
	const user = $derived($session.data?.user ?? data.session.user);

	// Platform administrators (Better Auth admin plugin) get a link to /admin; the route has
	// its own guard, this only decides whether to show the link.
	const showAdmin = $derived(isAdmin((user as { role?: string | null }).role));

	// Product analytics: attach the person once the user is known (no-op until configured + consented).
	$effect(() => {
		const id = user.id;
		analytics.identify(
			id,
			untrack(() => ({ email: user.email })),
		);
	});

	// Set while an admin is signed in as this user (`admin.impersonateUser`); the admin's own
	// session comes back with `stopImpersonating`.
	const impersonatedBy = $derived(
		(($session.data ?? data.session).session as { impersonatedBy?: string | null })
			.impersonatedBy ?? null,
	);
	let stoppingImpersonation = $state(false);

	async function stopImpersonating() {
		stoppingImpersonation = true;
		const result = await authClient.admin.stopImpersonating();
		stoppingImpersonation = false;
		if (result.error) {
			toast.error(result.error.message ?? m.shell_impersonation_stop_error());
			return;
		}
		await invalidateAll();
		await goto('/admin/users');
	}

	const links = [
		{ href: '/app', label: m.common_home(), icon: LayoutGridIcon },
		{ href: '/app/settings', label: m.common_settings(), icon: SettingsIcon },
	];

	function matches(pathname: string, href: string) {
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	function isActive(href: string) {
		const pathname = page.url.pathname.replace(/\/+$/, '') || '/';
		if (href === '/app') {
			return !links.some((link) => link.href !== '/app' && matches(pathname, link.href));
		}
		return matches(pathname, href);
	}

	const linkClass =
		'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent';

	// Mobile navigation (Sheet) and the command palette (Ctrl/⌘+K from anywhere in the shell).
	let sheetOpen = $state(false);
	let paletteOpen = $state(false);
	// The hint follows the keyboard the user actually has; decided after mount so SSR and the
	// static shell start from the same markup.
	let paletteKey = $state('⌘K');
	onMount(() => {
		if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform)) paletteKey = 'Ctrl K';
	});

	function onKeydown(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			paletteOpen = !paletteOpen;
		}
	}

	// A page that failed to render stays in the boundary's `failed` state until reset; navigating
	// away must show the new page, so the reset is replayed after the next navigation.
	let resetBoundary: (() => void) | null = null;

	afterNavigate(() => {
		sheetOpen = false;
		const reset = resetBoundary;
		resetBoundary = null;
		reset?.();
	});

	let resend = $state<'idle' | 'sending' | 'sent'>('idle');

	// Client-side guard. Server-side protection lives in the API (every procedure
	// behind `requireAuth`), so a missing session here only affects what is rendered.
	$effect(() => {
		if (!$session.isPending && !$session.data) void goto('/login');
	});

	async function signOut() {
		await authClient.signOut();
		await tokenStore.clear();
		analytics.signOut();
		// Nothing of this session may survive on the machine: the service worker's caches go too.
		await pwa.clearCaches();
		await goto('/login');
	}

	async function resendVerification() {
		resend = 'sending';
		const result = await authClient.sendVerificationEmail({
			email: user.email,
			callbackURL: `${location.origin}/verify-email`,
		});
		if (result.error) {
			resend = 'idle';
			toast.error(result.error.message ?? m.shell_banner_verify_resend_error());
			return;
		}
		resend = 'sent';
		toast.success(m.shell_banner_verify_sent_toast());
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet navigation()}
	<nav aria-label={m.shell_nav_label()}>
		<ul class="flex flex-col gap-1">
			{#each links as link (link.href)}
				{@const Icon = link.icon}
				<li>
					<a
						href={link.href}
						aria-current={isActive(link.href) ? 'page' : undefined}
						class={cn(linkClass, isActive(link.href) && 'bg-sidebar-accent font-medium')}
					>
						<Icon class="text-muted-foreground size-4" aria-hidden="true" />
						{link.label}
					</a>
				</li>
			{/each}
			{#if showAdmin}
				<li>
					<a href="/admin" class={linkClass}>
						<ShieldIcon class="text-muted-foreground size-4" aria-hidden="true" />
						{m.shell_nav_admin()}
					</a>
				</li>
			{/if}
		</ul>
	</nav>

	<Button
		variant="secondary"
		size="sm"
		class="justify-between"
		aria-keyshortcuts="Control+K Meta+K"
		onclick={() => (paletteOpen = true)}
	>
		<span class="flex items-center gap-2">
			<SearchIcon class="size-4" aria-hidden="true" />
			{m.shell_search_placeholder()}
		</span>
		<kbd class="text-secondary-foreground/80 font-sans text-xs">{paletteKey}</kbd>
	</Button>
{/snippet}

<!-- Theme, PWA controls and the account; sits at the bottom of the sidebar and the sheet. -->
{#snippet footer()}
	<div class="mt-auto flex flex-col gap-1 text-sm">
		{#if pwa.updateAvailable}
			<div
				role="status"
				class="border-border bg-muted mb-1 flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
			>
				<span>{m.shell_update_available()}</span>
				<Button
					variant="secondary"
					size="sm"
					class="h-7 px-2 text-xs"
					onclick={() => location.reload()}
				>
					<RefreshCwIcon class="size-3.5" aria-hidden="true" />
					{m.common_reload()}
				</Button>
			</div>
		{/if}
		{#if pwa.canInstall}
			<Button variant="ghost" size="sm" class="justify-start" onclick={() => pwa.install()}>
				<DownloadIcon class="size-4" aria-hidden="true" />
				{m.shell_install_app()}
			</Button>
		{/if}
		<ThemeToggle class="justify-start" />
		<p class="text-muted-foreground truncate px-3 text-xs" title={user.email}>{user.email}</p>
		<Button variant="ghost" size="sm" class="justify-start" onclick={signOut}>
			<LogOutIcon class="size-4" aria-hidden="true" />
			{m.common_sign_out()}
		</Button>
	</div>
{/snippet}

<a
	href="#main"
	class="focus:bg-primary focus:text-primary-foreground focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-offset-2 focus:outline-none"
>
	{m.common_skip_to_content()}
</a>

<div class="flex min-h-screen flex-col md:flex-row">
	<!-- Below md: a sticky top bar with the navigation in a sheet. -->
	<header
		class="border-border bg-background/95 sticky top-0 z-40 flex h-14 items-center gap-2 border-b px-3 backdrop-blur md:hidden"
	>
		<Sheet.Root bind:open={sheetOpen}>
			<Sheet.Trigger>
				{#snippet child({ props })}
					<Button variant="ghost" size="sm" class="px-2" aria-label={m.shell_nav_open()} {...props}>
						<MenuIcon class="size-5" aria-hidden="true" />
					</Button>
				{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="left" class="w-72 gap-0 p-0">
				<Sheet.Header class="border-border border-b">
					<Sheet.Title>{m.common_app_name()}</Sheet.Title>
					<Sheet.Description class="sr-only">{m.shell_nav_description()}</Sheet.Description>
				</Sheet.Header>
				<div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
					{@render navigation()}
					{@render footer()}
				</div>
			</Sheet.Content>
		</Sheet.Root>
		<a href="/app" class="font-semibold">{m.common_app_name()}</a>
		<Button
			variant="ghost"
			size="sm"
			class="ml-auto px-2"
			aria-label={m.common_search()}
			aria-keyshortcuts="Control+K Meta+K"
			onclick={() => (paletteOpen = true)}
		>
			<SearchIcon class="size-5" aria-hidden="true" />
		</Button>
	</header>

	<!-- From md: the sidebar. -->
	<aside
		class="border-border bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 flex-col gap-4 border-r p-4 md:sticky md:top-0 md:flex md:h-screen"
	>
		<a href="/app" class="px-2 font-semibold">{m.common_app_name()}</a>
		{@render navigation()}
		{@render footer()}
	</aside>

	<main id="main" tabindex="-1" class="min-w-0 flex-1 p-4 outline-none sm:p-6 md:p-8">
		{#if impersonatedBy}
			<Alert variant="error" class="mb-6 flex items-center justify-between gap-3">
				<span>{m.shell_impersonation_text({ email: user.email })}</span>
				<Button
					variant="outline"
					size="sm"
					disabled={stoppingImpersonation}
					onclick={stopImpersonating}
				>
					{stoppingImpersonation ? m.shell_impersonation_stopping() : m.shell_impersonation_stop()}
				</Button>
			</Alert>
		{/if}
		{#if user.emailVerified === false}
			<Alert class="mb-6 flex items-center justify-between gap-3">
				<span>{m.shell_banner_verify_text()}</span>
				{#if resend === 'sent'}
					<span class="text-muted-foreground">{m.shell_banner_verify_sent()}</span>
				{:else}
					<Button
						variant="outline"
						size="sm"
						disabled={resend === 'sending'}
						onclick={resendVerification}
					>
						{resend === 'sending' ? m.common_sending() : m.shell_banner_verify_resend()}
					</Button>
				{/if}
			</Alert>
		{/if}

		<svelte:boundary
			onerror={(error, reset) => {
				console.error(error);
				resetBoundary = reset;
			}}
		>
			{@render children()}

			{#snippet failed(_error, reset)}
				<div class="flex flex-col gap-4">
					<Alert variant="error">{m.shell_boundary_error()}</Alert>
					<div class="flex gap-2">
						<Button
							onclick={() => {
								resetBoundary = null;
								reset();
							}}
						>
							{m.common_try_again()}
						</Button>
						<Button variant="secondary" onclick={() => location.reload()}>
							{m.common_reload()}
						</Button>
					</div>
				</div>
			{/snippet}
		</svelte:boundary>
	</main>
</div>

<CommandPalette bind:open={paletteOpen} {showAdmin} onSignOut={signOut} />
