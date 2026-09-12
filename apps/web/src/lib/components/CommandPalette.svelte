<script lang="ts">
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { Command } from '@repo/ui';
	import { resetMode, setMode, userPrefersMode } from 'mode-watcher';
	import { goto } from '$app/navigation';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** Bound by the shell; the shell also toggles it from Ctrl/⌘+K. */
		open?: boolean;
		/** Platform administrators get an "Admin" entry. */
		showAdmin?: boolean;
		/** The shell's sign-out (clears the token store and analytics identity). */
		onSignOut: () => unknown;
	}

	let { open = $bindable(false), showAdmin = false, onSignOut }: Props = $props();

	// Keywords are extra (English) search aliases; the visible label and the item value are localised.
	const navigation = [
		{
			href: '/app',
			label: m.common_home(),
			icon: LayoutGridIcon,
			keywords: ['home', 'projects'],
		},
		{
			href: '/app/settings',
			label: m.common_settings(),
			icon: SettingsIcon,
			keywords: ['profile', 'password', 'security', 'sessions', 'account'],
		},
	];

	const theme = $derived(userPrefersMode.current);

	/** Every item closes the palette first, then acts. */
	function run(action: () => unknown) {
		open = false;
		void action();
	}

	function chooseTheme(value: 'light' | 'dark' | 'system') {
		if (value === 'system') resetMode();
		else setMode(value);
	}
</script>

<Command.Dialog
	bind:open
	title={m.shell_palette_title()}
	description={m.shell_palette_description()}
	label={m.shell_palette_title()}
	loop
>
	<Command.Input placeholder={m.shell_palette_placeholder()} autocomplete="off" />
	<Command.List>
		<Command.Empty>{m.shell_palette_empty()}</Command.Empty>

		<Command.Group heading={m.shell_palette_group_navigation()}>
			{#each navigation as item (item.href)}
				{@const Icon = item.icon}
				<Command.Item
					value={m.shell_palette_go_to({ page: item.label })}
					keywords={item.keywords}
					onSelect={() => run(() => goto(item.href))}
				>
					<Icon aria-hidden="true" />
					<span>{item.label}</span>
				</Command.Item>
			{/each}
			{#if showAdmin}
				<Command.Item
					value={m.shell_palette_go_to({ page: m.shell_nav_admin() })}
					keywords={['users', 'flags', 'system']}
					onSelect={() => run(() => goto('/admin'))}
				>
					<ShieldIcon aria-hidden="true" />
					<span>{m.shell_nav_admin()}</span>
				</Command.Item>
			{/if}
		</Command.Group>

		<Command.Group heading={m.common_theme()}>
			<Command.Item
				value={m.common_theme_current({ mode: m.common_theme_light() })}
				keywords={['appearance', 'mode']}
				data-checked={theme === 'light'}
				onSelect={() => run(() => chooseTheme('light'))}
			>
				<SunIcon aria-hidden="true" />
				<span>{m.common_theme_light()}</span>
			</Command.Item>
			<Command.Item
				value={m.common_theme_current({ mode: m.common_theme_dark() })}
				keywords={['appearance', 'mode']}
				data-checked={theme === 'dark'}
				onSelect={() => run(() => chooseTheme('dark'))}
			>
				<MoonIcon aria-hidden="true" />
				<span>{m.common_theme_dark()}</span>
			</Command.Item>
			<Command.Item
				value={m.common_theme_current({ mode: m.common_theme_system() })}
				keywords={['appearance', 'mode', 'auto']}
				data-checked={theme === 'system'}
				onSelect={() => run(() => chooseTheme('system'))}
			>
				<MonitorIcon aria-hidden="true" />
				<span>{m.common_theme_system()}</span>
			</Command.Item>
		</Command.Group>

		<Command.Group heading={m.shell_palette_group_account()}>
			<Command.Item
				value={m.common_sign_out()}
				keywords={['log out', 'logout']}
				onSelect={() => run(onSignOut)}
			>
				<LogOutIcon aria-hidden="true" />
				<span>{m.common_sign_out()}</span>
			</Command.Item>
		</Command.Group>
	</Command.List>
</Command.Dialog>
