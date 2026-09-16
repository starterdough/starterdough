import { fileURLToPath } from 'node:url';

/**
 * Load one Astro app's canonical configuration from its private environment files. A blank `SITE_URL`
 * carries no configuration, so it must not prevent the next, lower-precedence source from setting
 * that app's canonical origin. Nonempty inherited values still win over every file.
 *
 * @param {string | URL} configUrl
 */
export function loadSiteEnv(configUrl) {
	for (const name of ['.env.local', '.env']) {
		if (!process.env.SITE_URL?.trim()) delete process.env.SITE_URL;
		try {
			process.loadEnvFile(fileURLToPath(new URL(name, configUrl)));
		} catch {
			// Absent (or an old runtime without `loadEnvFile`): continue to the next source.
		}
	}
	if (!process.env.SITE_URL?.trim()) delete process.env.SITE_URL;
}
