<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import FlagIcon from '@lucide/svelte/icons/flag';
	import ServerIcon from '@lucide/svelte/icons/server';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { cn } from '@repo/ui';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { m } from '$lib/paraglide/messages';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// Seeded by the layout load (so SSR has it), kept live by the client afterwards.
	const session = authClient.useSession();
	const user = $derived($session.data?.user ?? data.session.user);

	const links = [
		{ href: '/admin/users', label: m.admin_nav_users(), icon: UsersIcon },
		{ href: '/admin/flags', label: m.admin_nav_flags(), icon: FlagIcon },
		{ href: '/admin/system', label: m.admin_nav_system(), icon: ServerIcon },
	];

	function isActive(href: string) {
		const pathname = page.url.pathname.replace(/\/+$/, '') || '/';
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	// Client-side guard for a session that ends while the page is open (sign-out in another tab).
	// The load re-checks the admin role on every navigation; the API enforces it regardless.
	$effect(() => {
		if (!$session.isPending && !$session.data) void goto('/login');
	});
</script>

<a
	href="#main"
	class="focus:bg-primary focus:text-primary-foreground focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-offset-2 focus:outline-none"
>
	{m.common_skip_to_content()}
</a>

<div class="flex min-h-screen flex-col md:flex-row">
	<aside
		class="border-border bg-sidebar text-sidebar-foreground flex w-full shrink-0 flex-col gap-4 border-b p-4 md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0"
	>
		<div class="flex items-baseline justify-between gap-2 px-2">
			<span class="font-semibold">{m.admin_title()}</span>
			<span class="text-muted-foreground text-xs">{m.common_app_name()}</span>
		</div>
		<nav aria-label={m.admin_nav_label()}>
			<ul class="flex flex-col gap-1">
				{#each links as link (link.href)}
					{@const Icon = link.icon}
					<li>
						<a
							href={link.href}
							aria-current={isActive(link.href) ? 'page' : undefined}
							class={cn(
								'hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
								isActive(link.href) && 'bg-sidebar-accent font-medium',
							)}
						>
							<Icon class="text-muted-foreground size-4" aria-hidden="true" />
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
		<div class="mt-auto flex flex-col gap-1 text-sm">
			<ThemeToggle class="justify-start" />
			<p class="text-muted-foreground truncate px-3 text-xs" title={user.email}>{user.email}</p>
			<a
				class="hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
				href="/app"
			>
				<ArrowLeftIcon class="text-muted-foreground size-4" aria-hidden="true" />
				{m.admin_nav_back_to_app()}
			</a>
		</div>
	</aside>
	<main id="main" tabindex="-1" class="min-w-0 flex-1 p-4 outline-none sm:p-6 md:p-8">
		{@render children()}
	</main>
</div>
