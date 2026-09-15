import type { CompilerOptions } from '@inlang/paraglide-js';

/**
 * Paraglide options shared by its programmatic compiler and Vite plugin. This file deliberately
 * lives outside `project.inlang`: the Inlang SDK manages that directory's ignore rules and permits
 * only `settings.json` to be source controlled.
 *
 * There are no URL prefixes, so one strategy chain serves SSR, the static SPA and Tauri:
 *  1. `cookie` is the explicit web choice and the only client store the server can read;
 *  2. `localStorage` preserves that choice in custom-scheme webviews that drop cookies;
 *  3. `preferredLanguage` reads `navigator.languages` or the request's `Accept-Language`;
 *  4. `baseLocale` falls back to English.
 * `setLocale()` writes the first two stores. The server naturally skips local storage.
 */
export const paraglideOptions = {
	project: './project.inlang',
	outdir: './src/lib/paraglide',
	strategy: ['cookie', 'localStorage', 'preferredLanguage', 'baseLocale'],
	isServer: 'import.meta.env.SSR',
	emitReadme: false,
	emitPrettierIgnore: false,
} satisfies CompilerOptions;
