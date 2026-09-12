<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { slideFade } from '../motion.js';
	import { cn } from '../utils.js';

	type Variant = 'info' | 'success' | 'warning' | 'error';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		variant?: Variant;
	}

	let { variant = 'info', class: className, children, ...rest }: Props = $props();

	const variants: Record<Variant, string> = {
		info: 'border-border bg-muted text-foreground',
		success: 'border-success/40 bg-success/10 text-success-foreground',
		warning: 'border-warning/40 bg-warning/10 text-warning-foreground',
		error: 'border-destructive/40 bg-destructive/10 text-destructive',
	};
</script>

<!--
	`transition:` lives here rather than at the call sites: every consumer wraps this in an `{#if}`
	(the same `{#snippet failure(...)}` appears verbatim in four route files), so one directive
	animates every banner in the app. Svelte skips intro transitions on the server-rendered first
	paint, so only a banner that appears in response to something the user did will move.
-->
<div
	role={variant === 'error' ? 'alert' : 'status'}
	class={cn('rounded-lg border px-3 py-2 text-sm', variants[variant], className)}
	{...rest}
	transition:slideFade
>
	{@render children?.()}
</div>
