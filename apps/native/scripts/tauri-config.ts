/**
 * Writes `apps/native/tauri.build.conf.json`, a fragment that the Tauri CLI merges over
 * `src-tauri/tauri.conf.json` (`--config`), carrying the two things the base config cannot know:
 *
 *   `version`  the release version, read from the root `package.json` (the repo's single source of
 *              truth). Tauri prefers `tauri.conf.json > version` over `Cargo.toml`, so this is what
 *              names `Starterdough_<version>_x64-setup.exe`. The same value is written back into
 *              `src-tauri/Cargo.toml` and `apps/native/package.json` so `tauri dev` and `cargo`
 *              agree with the installers.
 *   `csp`      a Content-Security-Policy whose `connect-src` names exactly the origins the bundled
 *              web app talks to: the API, the object store, Sentry and PostHog when configured.
 *              Tauri injects the policy as a response header (not a `<meta>` tag), so `frame-ancestors`
 *              applies as well.
 *
 * It reads the same env files as the web build, in Vite's `loadEnv` order for `vite build`, so the
 * CSP cannot drift from the URLs baked into the SPA. The base policy in `tauri.conf.json` allows any
 * `https:` origin; this one closes it down for the shipped binary. The file lives outside
 * `src-tauri/` on purpose: `tauri dev` restarts the app when anything in there changes.
 *
 *   bun run config                              # development defaults, localhost allowed
 *   bun run preview:desktop                     # same, in a debug binary on the real origin
 *   bun run build:desktop                       # --release: PUBLIC_API_URL + PUBLIC_WEB_URL required
 *   bun scripts/tauri-config.ts --release --dry-run   # print what a release build would embed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = resolve(here, '..');
const repoRoot = resolve(nativeDir, '../..');
const webDir = resolve(repoRoot, 'apps/web');
const outFile = resolve(nativeDir, 'tauri.build.conf.json');

/**
 * `--release` is what `build:desktop` and the mobile `*:build` scripts pass: the origins it bakes
 * into an installer a stranger will run have no safe default, so they become mandatory. `config`
 * and `preview:desktop` keep the localhost defaults. `--dry-run` prints without writing anything.
 */
const release = process.argv.includes('--release');
const dryRun = process.argv.includes('--dry-run');

/** Minimal `.env` reader: `KEY=value`, optional quotes, `#` comments. Vite does the same for the SPA. */
function readDotenv(file: string): Record<string, string> {
	if (!existsSync(file)) return {};
	const values: Record<string, string> = {};
	for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

/**
 * Vite's file order for `vite build` (mode `production`), each overriding the previous, with the
 * process environment winning over all of them. `.env.production` is what a deploy writes and what
 * `turbo.json` declares as a build input; reading only `.env` would make the "cannot drift"
 * claim false.
 */
const envFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
const env: Record<string, string | undefined> = {};
for (const file of envFiles) Object.assign(env, readDotenv(resolve(webDir, file)));
Object.assign(env, process.env);

const get = (key: string) => env[key]?.trim() || undefined;

function originOf(value: string, what: string): string {
	try {
		return new URL(value).origin;
	} catch {
		throw new Error(`${what} is not an absolute URL: ${value}`);
	}
}

/** Reserved example domains (RFC 2606 / 6761): whatever is here, nobody filled the variable in. */
const placeholderHost = /(^|\.)(example\.(com|org|net)|invalid|test|localdomain)$/;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A release build bakes these origins into installers, so an unset variable must fail here rather
 * than ship as `api.example.com`; the CSP derives from the same value, so nothing else would
 * notice. Development and preview builds keep their localhost default.
 */
function requiredOrigin(key: string, developmentDefault: string): string {
	const value = get(key);
	if (!value) {
		if (!release) return originOf(developmentDefault, key);
		throw new Error(
			`${key} is not set. A release build bakes it into the installer, so there is no safe ` +
				`default — set it in apps/web/.env.production or the environment (apps/native/README.md).`,
		);
	}
	const origin = originOf(value, key);
	const { hostname } = new URL(origin);
	if (release && placeholderHost.test(hostname)) {
		throw new Error(`${key} is still a placeholder (${value}) — a release build would ship it.`);
	}
	if (release && loopbackHosts.has(hostname)) {
		console.warn(`warning: ${key} is ${origin} — the installer will only work on this machine.`);
	}
	return origin;
}

const apiOrigin = requiredOrigin('PUBLIC_API_URL', 'http://localhost:3000');

// The deployed web origin. The shell hands OAuth and other return trips to the system browser, so
// it is never fetched from inside the webview and stays out of `connect-src`. An installer
// built without it dead-ends those flows, so a release build demands it.
requiredOrigin('PUBLIC_WEB_URL', 'http://localhost:5173');

const connect = new Set<string>(["'self'", apiOrigin]);
const scripts = new Set<string>(["'self'"]);

// The object store the browser PUTs presigned uploads to. Empty means the local disk driver, whose
// URLs the API signs on its own origin (already allowed); with S3/R2 it is the bucket endpoint the
// presigned URL points at, which is invisible to the browser build unless it is named here.
const storageOrigin = get('PUBLIC_STORAGE_ORIGIN');
if (storageOrigin) connect.add(originOf(storageOrigin, 'PUBLIC_STORAGE_ORIGIN'));

// Sentry: the browser SDK posts envelopes to the DSN's host.
const sentryDsn = get('PUBLIC_SENTRY_DSN');
if (sentryDsn) connect.add(originOf(sentryDsn, 'PUBLIC_SENTRY_DSN'));

// PostHog: events go to the API host; lazily loaded bundles come from its `*-assets` twin.
if (get('PUBLIC_POSTHOG_KEY')) {
	const host = originOf(
		get('PUBLIC_POSTHOG_HOST') ?? 'https://us.i.posthog.com',
		'PUBLIC_POSTHOG_HOST',
	);
	connect.add(host);
	scripts.add(host.replace(/^(https:\/\/[a-z]+)\.i\.posthog\.com$/, '$1-assets.i.posthog.com'));
}

const csp = [
	"default-src 'self'",
	`script-src ${[...scripts].join(' ')}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	`connect-src ${[...connect].join(' ')}`,
	// Tauri sends the policy as a `Content-Security-Policy` response header, so all three are
	// enforced (`frame-ancestors` would be ignored in a `<meta>` tag): no `<base>` rewrite of a
	// relative API path, no form posting credentials to a foreign origin, never embedded in a frame.
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join('; ');

/** The root `package.json` version is the repo's single source of truth. */
function rootVersion(): string {
	const file = resolve(repoRoot, 'package.json');
	const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
		throw new Error(`${file}: "version" must be a semver string, got ${JSON.stringify(version)}`);
	}
	return version;
}

/**
 * Rewrite the one `version` line in a file when it has drifted. `src-tauri/tauri.conf.json`
 * deliberately carries no `version` key: Tauri falls back to `Cargo.toml`, so `tauri dev` (which
 * never sees this fragment) and `cargo` report the same version as the installers, and there is no
 * fourth copy to keep in step.
 */
function syncVersion(file: string, pattern: RegExp, replacement: string) {
	const before = readFileSync(file, 'utf8');
	const found = before.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
	if (found.length !== 1) {
		throw new Error(`${file}: expected one line matching ${pattern}, found ${found.length}`);
	}
	if (found[0] === replacement) return;
	if (!dryRun) writeFileSync(file, before.replace(pattern, replacement));
	console.log(`${dryRun ? 'would sync' : 'synced'} ${file} → ${replacement.trim()}`);
}

const version = rootVersion();
syncVersion(
	resolve(nativeDir, 'src-tauri/Cargo.toml'),
	/^version = "[^"]*"$/m,
	`version = "${version}"`,
);
syncVersion(
	resolve(nativeDir, 'package.json'),
	/^\t"version": "[^"]*",$/m,
	`\t"version": "${version}",`,
);

const fragment = {
	$schema: 'https://schema.tauri.app/config/2',
	version,
	app: { security: { csp } },
};
const contents = `${JSON.stringify(fragment, null, '\t')}\n`;
if (!dryRun) writeFileSync(outFile, contents);

console.log(
	`${dryRun ? 'would write' : 'wrote'} tauri.build.conf.json (${release ? 'release' : 'development'})`,
);
console.log(`  version      ${version}`);
console.log(`  connect-src  ${[...connect].join(' ')}`);
console.log(`  csp          ${csp}`);
