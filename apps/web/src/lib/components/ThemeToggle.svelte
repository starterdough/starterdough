<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { Button, DropdownMenu } from '@repo/ui';
	import { resetMode, setMode, userPrefersMode } from 'mode-watcher';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		class?: string;
		/** Hide the caption and show only the icon. */
		compact?: boolean;
	}

	let { class: className, compact = false }: Props = $props();

	// 'light' | 'dark' | 'system': the stored preference; the applied mode is on <html>.
	const preference = $derived(userPrefersMode.current);
	const labels = $derived({
		light: m.common_theme_light(),
		dark: m.common_theme_dark(),
		system: m.common_theme_system(),
	});

	function choose(value: string) {
		if (value === 'system') resetMode();
		else if (value === 'light' || value === 'dark') setMode(value);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				variant="ghost"
				size="sm"
				class={className}
				aria-label={m.common_theme_current({ mode: labels[preference] })}
				{...props}
			>
				<SunIcon class="size-4 dark:hidden" aria-hidden="true" />
				<MoonIcon class="hidden size-4 dark:block" aria-hidden="true" />
				{#if !compact}
					<span>{m.common_theme()}</span>
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.RadioGroup value={preference} onValueChange={choose}>
			<DropdownMenu.RadioItem value="light">
				<SunIcon aria-hidden="true" />
				{labels.light}
			</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem value="dark">
				<MoonIcon aria-hidden="true" />
				{labels.dark}
			</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem value="system">
				<MonitorIcon aria-hidden="true" />
				{labels.system}
			</DropdownMenu.RadioItem>
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
