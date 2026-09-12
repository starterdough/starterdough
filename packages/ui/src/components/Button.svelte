<script lang="ts" module>
	/**
	 * The app's Button vocabulary, kept as a thin wrapper over the shadcn Button so there is one
	 * implementation, one 32 px size scale and one focus treatment in the bundle (D23).
	 *
	 * | this prop            | shadcn Button   |
	 * | -------------------- | --------------- |
	 * | `variant="primary"`  | `"default"`     |
	 * | `variant="secondary"`| `"secondary"`   |
	 * | `variant="outline"`  | `"outline"`     |
	 * | `variant="ghost"`    | `"ghost"`       |
	 * | `variant="danger"`   | `"destructive"` |
	 * | `size="sm"`          | `"sm"` (28 px)  |
	 * | `size="md"` (default)| `"default"` (32 px) |
	 * | `size="lg"`          | `"lg"` (36 px)  |
	 *
	 * `outline` and `ghost` are not interchangeable, and the difference is an affordance rather than
	 * a taste: `ghost` has no border and no fill until it is hovered, so it reads as text. Use it
	 * only where its neighbours are equally bare: inside a menu, as an icon-only trigger, or as the
	 * Cancel beside a filled confirm, where the pairing is the hierarchy. A standalone action that
	 * sits beside a `secondary`, `primary` or `danger` button takes `outline`, so that every control
	 * in the row looks like a control.
	 *
	 * Icon-only buttons, button groups and the `link` variant have no name here: import
	 * `@repo/ui/components/ui/button/index.js` directly for those.
	 */
	export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
	export type ButtonSize = 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
	import {
		type ButtonProps,
		Button as ShadcnButton,
		type ButtonSize as ShadcnButtonSize,
		type ButtonVariant as ShadcnButtonVariant,
	} from './ui/button/index.js';

	interface Props extends Omit<ButtonProps, 'variant' | 'size'> {
		variant?: ButtonVariant;
		size?: ButtonSize;
	}

	let {
		variant = 'primary',
		size = 'md',
		ref = $bindable(null),
		children,
		...rest
	}: Props = $props();

	const variants: Record<ButtonVariant, ShadcnButtonVariant> = {
		primary: 'default',
		secondary: 'secondary',
		outline: 'outline',
		ghost: 'ghost',
		danger: 'destructive',
	};

	const sizes: Record<ButtonSize, ShadcnButtonSize> = {
		sm: 'sm',
		md: 'default',
		lg: 'lg',
	};
</script>

<ShadcnButton bind:ref variant={variants[variant]} size={sizes[size]} {...rest}>
	{@render children?.()}
</ShadcnButton>
