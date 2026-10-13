import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Overlay from './overlay-bounds.fixture.svelte';
// The app's own stylesheet, so each overlay is laid out as it is in the browser.
import '../routes/layout.css';

/**
 * Each of `@repo/ui`'s overlays, by the `data-slot` of its box. A short window cannot hold their
 * forty rows, so each must stop inside it and scroll; the dialog is held to the same in
 * `api-keys-page.svelte.spec.ts`.
 */
const overlays = [
	['submenu', 'dropdown-menu-sub-content'],
	['popover', 'popover-content'],
	['command', 'dialog-content'],
	['sheet-top', 'sheet-content'],
	['sheet-bottom', 'sheet-content'],
	['sheet-right', 'sheet-content'],
] as const;

/** Is `inner` inside `outer`, give or take the sub-pixel rounding of layout? */
const within = (inner: DOMRect, outer: DOMRect) =>
	inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

test.each(overlays)(
	'keeps the %s inside a short window, its last row within reach',
	async (overlay, slot) => {
		const previous = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(1024, 400);
		try {
			render(Overlay, { overlay });
			const last = page.getByText('Row 40', { exact: true });
			await expect.element(last).toBeInTheDocument();
			const row = last.element();
			const box = row.closest(`[data-slot="${slot}"]`);
			expect(box).not.toBeNull();
			if (!box) return;
			// Measured once it has finished opening, and once Floating UI has placed it.
			await Promise.all(
				box.getAnimations({ subtree: true }).map((animation) => animation.finished),
			);
			const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
			await expect.poll(() => within(box.getBoundingClientRect(), viewport)).toBe(true);

			// The rows scroll inside it, so the last can be brought into view there.
			row.scrollIntoView({ block: 'nearest' });
			expect(within(row.getBoundingClientRect(), box.getBoundingClientRect())).toBe(true);
		} finally {
			await page.viewport(previous.width, previous.height);
		}
	},
);
