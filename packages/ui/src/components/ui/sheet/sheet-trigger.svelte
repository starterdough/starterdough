<script lang="ts">
	import { Dialog as SheetPrimitive } from 'bits-ui';

	// `type="button"` like the dialog wrappers: bits-ui renders a bare <button>, which submits the
	// form it happens to sit inside.
	let {
		ref = $bindable(null),
		type = 'button',
		...restProps
	}: SheetPrimitive.TriggerProps = $props();
</script>

<SheetPrimitive.Trigger bind:ref data-slot="sheet-trigger" {type} {...restProps} />
