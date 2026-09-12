<script lang="ts">
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import { Button, DropdownMenu } from '@repo/ui';
	import { getLocale, type Locale, localeName, locales, switchLocale } from '$lib/i18n';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		class?: string;
		/** Hide the caption and show only the icon. */
		compact?: boolean;
	}

	let { class: className, compact = false }: Props = $props();

	const current = getLocale();

	function choose(value: string) {
		if ((locales as readonly string[]).includes(value)) switchLocale(value as Locale);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				variant="ghost"
				size="sm"
				class={className}
				aria-label="{m.common_language()}: {localeName(current)}"
				{...props}
			>
				<LanguagesIcon class="size-4" aria-hidden="true" />
				{#if !compact}
					<span>{localeName(current)}</span>
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.RadioGroup value={current} onValueChange={choose}>
			{#each locales as locale (locale)}
				<DropdownMenu.RadioItem value={locale} lang={locale}>
					{localeName(locale)}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
