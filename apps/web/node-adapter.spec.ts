import type { Adapter, Builder } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { nodeAdapter, withHtmlContentType } from './node-adapter';

/** An adapter that only records what it was handed. */
function recorder() {
	const seen: { mimeTypes?: Record<string, string>; appPath?: string } = {};
	const adapter: Adapter = {
		name: 'recorder',
		adapt(builder) {
			seen.mimeTypes = builder.mimeTypes;
			seen.appPath = builder.getAppPath();
		},
	};
	return { adapter, seen };
}

const builder = {
	mimeTypes: { '.js': 'text/javascript', '.txt': 'text/plain' },
	getAppPath: () => '_app',
} as unknown as Builder;

describe('withHtmlContentType', () => {
	it('adds .html to the table the adapter serves prerendered pages from', async () => {
		const { adapter, seen } = recorder();
		await withHtmlContentType(adapter).adapt(builder);
		expect(seen.mimeTypes).toEqual({
			'.html': 'text/html',
			'.js': 'text/javascript',
			'.txt': 'text/plain',
		});
	});

	it("keeps SvelteKit's own .html entry and the rest of the builder", async () => {
		const { adapter, seen } = recorder();
		const html = { ...builder, mimeTypes: { '.html': 'text/html; x=y' } } as unknown as Builder;
		await withHtmlContentType(adapter).adapt(html);
		expect(seen.mimeTypes).toEqual({ '.html': 'text/html; x=y' });
		expect(seen.appPath).toBe('_app');
	});

	it('wraps adapter-node without losing its name or Vite plugins', () => {
		const adapter = nodeAdapter();
		expect(adapter.name).toBe('@sveltejs/adapter-node');
		expect(adapter.vite).toBeDefined();
	});
});
