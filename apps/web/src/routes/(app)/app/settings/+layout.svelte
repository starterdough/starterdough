<script lang="ts">
	import { cn } from '@repo/ui';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';

	let { children } = $props();

	const tabs = [
		{ href: '/app/settings', label: m.shell_settings_tab_profile() },
		{ href: '/app/settings/security', label: m.shell_settings_tab_security() },
		{ href: '/app/settings/sessions', label: m.shell_settings_tab_sessions() },
	];

	function isActive(href: string) {
		const pathname = page.url.pathname.replace(/\/+$/, '') || '/';
		return pathname === href;
	}
</script>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
	<h1 class="text-2xl font-semibold">{m.common_settings()}</h1>

	<nav class="border-border flex gap-1 border-b" aria-label={m.shell_settings_nav_label()}>
		{#each tabs as tab (tab.href)}
			<a
				href={tab.href}
				aria-current={isActive(tab.href) ? 'page' : undefined}
				class={cn(
					'focus-visible:ring-ring -mb-px rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
					isActive(tab.href)
						? 'border-foreground text-foreground font-medium'
						: 'text-muted-foreground hover:text-foreground border-transparent',
				)}
			>
				{tab.label}
			</a>
		{/each}
	</nav>

	{@render children()}
</div>
