<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../utils.js';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		title: string;
		description?: string;
		/** Usually a lucide icon; rendered inside a muted circle. */
		icon?: Snippet;
		/** Call to action: a Button or a link. */
		action?: Snippet;
	}

	let { title, description, icon, action, class: className, children, ...rest }: Props = $props();
</script>

<div
	class={cn(
		'border-border flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
		className,
	)}
	{...rest}
>
	{#if icon}
		<div
			class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full [&_svg]:size-5"
			aria-hidden="true"
		>
			{@render icon()}
		</div>
	{/if}
	<div class="flex flex-col gap-1">
		<p class="text-base font-semibold">{title}</p>
		{#if description}
			<p class="text-muted-foreground max-w-sm text-sm">{description}</p>
		{/if}
	</div>
	{#if action}
		<div class="mt-2 flex flex-wrap justify-center gap-2">{@render action()}</div>
	{/if}
	{@render children?.()}
</div>
