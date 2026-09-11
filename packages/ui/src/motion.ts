/**
 * Motion for content that mounts and unmounts.
 *
 * `MOTION_MS` matches the 100–200 ms the shadcn overlays already use (`duration-100` on the dialog,
 * dropdown and popover, `duration-200` on the sheet), so a banner appearing and a dialog opening
 * read as the same app rather than two different ones. Svelte's own default is 400 ms, which is
 * slow enough to feel like latency on a status message.
 *
 * Reduced motion is deliberately *not* handled here. These compile to `@keyframes`, and
 * `theme.css` collapses every animation in the app — these included — from one media query, so
 * there is nothing to opt into per call site. See the `prefers-reduced-motion` block there.
 */

import type { SlideParams, TransitionConfig } from 'svelte/transition';
import { slide } from 'svelte/transition';

/** Milliseconds, shared so every mount/unmount in the app moves at one speed. */
export const MOTION_MS = 150;

/**
 * `slide` plus opacity.
 *
 * `slide` alone animates the box (height, padding, margin, border-width) but not the ink, so a
 * bordered element snaps to full strength at zero height before it has anywhere to be. Fading it
 * with the box is the difference between "makes room" and "pops in".
 *
 * Composed here because Svelte allows one `transition:` per element, so the call site cannot stack
 * `slide` and `fade` itself.
 */
export function slideFade(node: Element, params?: SlideParams): TransitionConfig {
	const base = slide(node, { duration: MOTION_MS, ...params });
	return {
		...base,
		css: (t, u) => `${base.css?.(t, u) ?? ''}; opacity: ${t};`,
	};
}
