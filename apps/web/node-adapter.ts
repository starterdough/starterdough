import node from '@sveltejs/adapter-node';
import type { Adapter, Builder } from '@sveltejs/kit';

/**
 * `@sveltejs/adapter-node`, plus the one content type its static server cannot work out.
 *
 * adapter-node 6 serves prerendered pages from a table it writes at build time, with each file's
 * `Content-Type` looked up by extension in `builder.mimeTypes`. SvelteKit 3.0 fills that from the
 * client files and the prerendered *paths* (`/offline`, no extension), never from the `.html`
 * files those paths are written to, so `/offline` goes out with no `Content-Type` at all. Behind
 * Caddy, which sends `X-Content-Type-Options: nosniff`, the browser then shows the offline page as
 * plain-text source. Upstream's own entry wins once it has one, so this is safe to leave in until
 * a SvelteKit release lists `.html` itself.
 */
export function nodeAdapter(): Adapter {
	return withHtmlContentType(node());
}

/** `adapter`, handed a builder whose `mimeTypes` always include `.html`. */
export function withHtmlContentType(adapter: Adapter): Adapter {
	return {
		...adapter,
		adapt: (builder) =>
			adapter.adapt(
				// Inherit everything else from the real builder; its methods do not depend on `this`
				// beyond what the prototype chain still provides.
				Object.create(builder, {
					mimeTypes: { get: () => ({ '.html': 'text/html', ...builder.mimeTypes }) },
				}) as Builder,
			),
	};
}
