/**
 * Rename the kit to your product.
 *
 *   bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme
 *   bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
 *
 * Dry run unless `--write` is passed. Add `--verbose` to see every changed line.
 *
 * Rewrites four tokens across the tracked text files: the product name, the lowercase slug (npm
 * package name, Cargo crate, Compose project, Postgres role, container names, the
 * `x-<slug>-client-ip` header, the backup artefact prefix) and its uppercase form in environment
 * variable names (`<SLUG>_STATE_DIR`), the Tauri bundle identifier, and the workspace scope. The
 * current values are read from the repo, so a second run with different arguments works. In each
 * `package.json` it rewrites, the dependency maps are put back in the order `bun add` keeps them.
 *
 * What a text substitution cannot safely do (Docker volumes, an existing dev database, the
 * untracked `.env`, lockfiles, the seller's GitHub coordinates) is printed as a checklist at the end.
 */
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

/**
 * The seller's own repository, left verbatim everywhere: `UPGRADING.md` needs it to stay pointed
 * at the kit. Each edition is published from its own repository, so the value is per edition.
 */
const KIT_REPO = 'starterdough/starterdough';

/**
 * The seller's own site, left verbatim. The slug rule is `starterdough(?![a-z])` and a dot is not
 * `[a-z]`, so an unprotected rewrite would turn `starterdough.dev` into a domain you do not own.
 */
const SELLER_SITE = 'starterdough.dev';

/**
 * The kit by its own name, where a page says what your repository is built on ("<Product>, built
 * on the Starterdough kit", QUICKSTART.md's agent prompt). The product name rule would make it
 * "built on the <Product> kit".
 */
const KIT_NAME = 'Starterdough kit';

/** Strings the rewrite steps over instead of substituting. None is a prefix of another. */
const VERBATIM = [KIT_REPO, SELLER_SITE, KIT_NAME];

/** Files that describe the kit rather than your product; renaming them makes them wrong. */
const KEEP_VERBATIM = new Set([
	'LICENSE.md',
	'THIRD-PARTY.md',
	'CHANGELOG.md',
	'UPGRADING.md',
	'scripts/rename.ts',
]);

/**
 * The seller's tools that generate and publish the free edition, their tests, and the files they
 * carry into it. They name the seller's repositories and site on purpose, and their tests, which
 * `bun run test:seller` runs (`bun run test` does not), check those literal names: renamed, the
 * tools would point at repositories you do not own and the tests would fail. The free edition
 * ships none of them.
 */
const SELLER_TOOLING: RegExp[] = [];

function sellerTooling(path: string): boolean {
	return SELLER_TOOLING.some((pattern) => pattern.test(path));
}

/** Lockfiles are regenerated, not edited; the rest is generated or binary. */
const SKIP_PATTERNS = [/\.lock$/, /(^|\/)src-tauri\/gen\//, /(^|\/)dist\//, /(^|\/)build\//];
const BINARY_EXTENSIONS = new Set([
	'png',
	'ico',
	'icns',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'pdf',
	'mp4',
	'zip',
	'gz',
	'node',
	'wasm',
]);

type Args = {
	name?: string;
	slug?: string;
	identifier?: string;
	scope?: string;
	write: boolean;
	verbose: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = { write: false, verbose: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--write') {
			args.write = true;
			continue;
		}
		if (flag === '--verbose') {
			args.verbose = true;
			continue;
		}
		const value = argv[i + 1];
		if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
			fail(`missing value for ${flag}`);
		}
		switch (flag) {
			case '--name':
				args.name = value;
				break;
			case '--slug':
				args.slug = value;
				break;
			case '--identifier':
				args.identifier = value;
				break;
			case '--scope':
				args.scope = value;
				break;
			default:
				fail(`unknown option ${flag}`);
		}
		i++;
	}
	return args;
}

function fail(message: string): never {
	console.error(`rename: ${message}\n`);
	console.error(
		'usage: bun run rename --name <ProductName> --slug <slug> --identifier <com.example.desktop> --scope <@scope> [--write] [--verbose]',
	);
	process.exit(1);
}

const args = parseArgs(Bun.argv.slice(2));
const { name, slug, identifier, scope: rawScope } = args;
if (!name || !slug || !identifier || !rawScope) {
	fail('--name, --slug, --identifier and --scope are all required');
}

// The slug becomes a Cargo crate name, an npm package name and a Compose project name at once.
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
	fail(`--slug must be lowercase letters, digits and dashes: got "${slug}"`);
}
if (/\n/.test(name) || !name.trim()) fail('--name must be a single non-empty line');
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(identifier)) {
	fail(`--identifier must be reverse-domain form, e.g. com.acme.desktop: got "${identifier}"`);
}
// macOS rejects a bundle identifier ending in `.app`.
if (identifier.endsWith('.app')) {
	fail('--identifier must not end in ".app" — macOS rejects that bundle identifier');
}
const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
	fail(`--scope must be @ plus lowercase letters, digits and dashes: got "${rawScope}"`);
}

/** Reads the values currently in the repo so the script is not pinned to "Starterdough". */
async function currentValues() {
	const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
		name?: string;
	};
	const tauri = JSON.parse(
		await readFile(join(repoRoot, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'),
	) as { productName?: string; identifier?: string };
	const shared = JSON.parse(
		await readFile(join(repoRoot, 'packages/tsconfig/package.json'), 'utf8'),
	) as { name?: string };
	const currentScope = shared.name?.split('/')[0];
	if (!rootManifest.name || !tauri.productName || !tauri.identifier || !currentScope) {
		fail('could not read the current name, slug, identifier and scope from the repo');
	}
	return {
		name: tauri.productName,
		slug: rootManifest.name,
		identifier: tauri.identifier,
		scope: currentScope,
	};
}

const current = await currentValues();

/**
 * Order matters: the identifier contains the slug, so it is replaced first. `(?![a-z])` stops the
 * slug matching inside a longer word (a slug that is a prefix of an English word) while still
 * matching `<slug>_`, `<slug>-api`, `<slug>:` and `<slug>` at end of line.
 */
const rules: Array<{ label: string; from: RegExp; to: string }> = [];
if (current.identifier !== identifier) {
	rules.push({
		label: `identifier  ${current.identifier} → ${identifier}`,
		from: new RegExp(escapeRegExp(current.identifier), 'g'),
		to: identifier,
	});
}
if (current.scope !== scope) {
	rules.push({
		label: `scope       ${current.scope}/ → ${scope}/`,
		from: new RegExp(`${escapeRegExp(current.scope)}/`, 'g'),
		to: `${scope}/`,
	});
}
// Environment variable names: `STARTERDOUGH_STATE_DIR` → `ACME_STATE_DIR` (a dash cannot be in a
// shell variable name, so `my-app` becomes `MY_APP`). Only `<PREFIX>_` is a variable name, and it
// runs before the name rule, so a product named in capitals (`ACME`) is renamed in prose by the name
// rule and in variable names by this one.
if (current.slug !== slug) {
	rules.push({
		label: `env prefix  ${envPrefix(current.slug)}_ → ${envPrefix(slug)}_`,
		from: new RegExp(`(?<![A-Z0-9_])${escapeRegExp(envPrefix(current.slug))}(?=_)`, 'g'),
		to: envPrefix(slug),
	});
}
if (current.name !== name) {
	rules.push({
		label: `name        ${current.name} → ${name}`,
		from: new RegExp(`${escapeRegExp(current.name)}(?![a-z])`, 'g'),
		to: name,
	});
}
if (current.slug !== slug) {
	rules.push({
		label: `slug        ${current.slug} → ${slug}`,
		from: new RegExp(`${escapeRegExp(current.slug)}(?![a-z])`, 'g'),
		to: slug,
	});
}
if (!rules.length) {
	console.log('Nothing to do: the repo already uses these values.');
	process.exit(0);
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envPrefix(value: string): string {
	return value.toUpperCase().replaceAll('-', '_');
}

/** The maps `bun add` re-sorts whenever it touches one. */
const DEPENDENCY_MAPS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
];

/**
 * A new scope sorts somewhere else (`@repo/db` came after `@orpc/server`, `@acme/db` comes
 * before it), and the first `bun add` in your fork re-sorts the whole map. A later release renamed
 * on `kit-renamed` would then disagree with your `main` about the order of every line it touches.
 * So the rename leaves each map sorted the way Bun keeps it: by name, in code-unit order. Only a
 * map of one-line `"name": "range"` entries is touched; anything else is left as it is.
 */
function sortDependencyMaps(text: string): string {
	let output = text;
	for (const key of DEPENDENCY_MAPS) {
		output = output.replace(
			new RegExp(`(\\n(\\t+)"${key}": \\{\\n)([\\s\\S]*?)(\\n\\2\\})`),
			(whole, open: string, _indent: string, body: string, close: string) => {
				const lines = body.split('\n');
				const entry = /^\s*"([^"]+)": "[^"]*",?$/;
				if (!lines.every((line) => entry.test(line))) return whole;
				const name = (line: string) => entry.exec(line)?.[1] ?? '';
				const sorted = lines
					.map((line) => line.replace(/,$/, ''))
					.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))
					.map((line, index, all) => (index < all.length - 1 ? `${line},` : line));
				return `${open}${sorted.join('\n')}${close}`;
			},
		);
	}
	return output;
}

/**
 * Split on the strings that must survive and rewrite only the segments around them. The capturing
 * group makes `String.split` return the separators at the odd indices.
 */
const VERBATIM_PATTERN = new RegExp(`(${VERBATIM.map(escapeRegExp).join('|')})`);

function rewrite(text: string): { output: string; replacements: number } {
	let replacements = 0;
	const output = text
		.split(VERBATIM_PATTERN)
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			let rewritten = segment;
			for (const rule of rules) {
				rewritten = rewritten.replace(rule.from, () => {
					replacements++;
					return rule.to;
				});
			}
			return rewritten;
		})
		.join('');
	return { output, replacements };
}

async function trackedFiles(): Promise<string[]> {
	const git = Bun.spawn(['git', 'ls-files', '-z'], { cwd: repoRoot, stdout: 'pipe' });
	const stdout = await new Response(git.stdout).text();
	if ((await git.exited) !== 0) fail('`git ls-files` failed — run this from inside the checkout');
	return stdout.split('\0').filter(Boolean);
}

function skipped(path: string): string | undefined {
	if (KEEP_VERBATIM.has(path)) return 'describes the kit, not your product';
	if (sellerTooling(path)) return "the seller's free-edition tooling";
	if (SKIP_PATTERNS.some((pattern) => pattern.test(path))) return 'generated or a lockfile';
	const extension = basename(path).split('.').pop()?.toLowerCase();
	if (extension && BINARY_EXTENSIONS.has(extension)) return 'binary';
	return undefined;
}

type Change = { path: string; replacements: number; lines: Array<[string, string]> };

const changes: Change[] = [];
const skippedWithMatches: string[] = [];
let scanned = 0;

for (const path of await trackedFiles()) {
	const reason = skipped(path);
	const absolute = join(repoRoot, path);
	let text: string;
	try {
		text = await readFile(absolute, 'utf8');
	} catch {
		continue;
	}
	// A NUL byte means it really is binary and slipped past the extension list.
	if (text.includes(String.fromCharCode(0))) continue;
	if (reason) {
		if (rewrite(text).replacements > 0) skippedWithMatches.push(`${path} (${reason})`);
		continue;
	}
	scanned++;
	const rewritten = rewrite(text);
	const { replacements } = rewritten;
	if (!replacements) continue;
	const output =
		basename(path) === 'package.json' ? sortDependencyMaps(rewritten.output) : rewritten.output;
	const before = text.split(/\r?\n/);
	const after = output.split(/\r?\n/);
	const lines: Array<[string, string]> = [];
	for (let i = 0; i < before.length; i++) {
		const oldLine = before[i] ?? '';
		const newLine = after[i] ?? '';
		if (oldLine !== newLine) lines.push([oldLine.trim(), newLine.trim()]);
	}
	changes.push({ path, replacements, lines });
	if (args.write) await Bun.write(absolute, output);
}

const totalReplacements = changes.reduce((sum, change) => sum + change.replacements, 0);

console.log(`\n${args.write ? 'Rewrote' : 'Would rewrite'} — ${rules.length} token(s):\n`);
for (const rule of rules) console.log(`  ${rule.label}`);

console.log(
	`\n${changes.length} of ${scanned} tracked text files, ${totalReplacements} occurrences:\n`,
);
changes.sort((a, b) => b.replacements - a.replacements);
const listed = args.verbose ? changes : changes.slice(0, 30);
for (const change of listed) {
	console.log(`  ${String(change.replacements).padStart(4)}  ${change.path}`);
	if (args.verbose) {
		for (const [oldLine, newLine] of change.lines) {
			console.log(`        - ${oldLine}`);
			console.log(`        + ${newLine}`);
		}
	}
}
if (listed.length < changes.length) {
	const rest = changes.slice(listed.length);
	const restCount = rest.reduce((sum, change) => sum + change.replacements, 0);
	console.log(`  … and ${rest.length} more files (${restCount} occurrences) — --verbose for all`);
}

if (skippedWithMatches.length) {
	console.log('\nLeft verbatim on purpose:\n');
	for (const entry of skippedWithMatches) console.log(`  ${entry}`);
}

const verbatimSites = await (async () => {
	// The coordinates you may want to repoint; the kit's name is not one of them.
	const args = [KIT_REPO, SELLER_SITE].flatMap((value) => ['-e', value]);
	const grep = Bun.spawn(['git', 'grep', '-n', '--fixed-strings', ...args], {
		cwd: repoRoot,
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const stdout = await new Response(grep.stdout).text();
	await grep.exited;
	// Only what you may want to repoint: the seller's tooling names the seller on purpose.
	return stdout
		.split('\n')
		.filter((line) => line && !sellerTooling(line.slice(0, line.indexOf(':'))));
})();

const oldSlug = current.slug;
const aiServiceRow = '';
console.log(`
================================================================================
Residue checklist — none of this is a text substitution, so the script left it
================================================================================

1. Docker volumes. The Compose project name changed (${oldSlug} → ${slug}, ${oldSlug}-dev →
   ${slug}-dev), so Compose will look for new, empty volumes and your data will look like it
   vanished. Either copy each volume across before the next \`up\`:

     docker volume create ${slug}_pgdata
     docker run --rm -v ${oldSlug}_pgdata:/from -v ${slug}_pgdata:/to alpine sh -c 'cd /from && cp -a . /to'

   (repeat for every other volume \`docker volume ls --filter name=${oldSlug}_\` lists and, for the
   dev database, ${oldSlug}-dev_pgdata → ${slug}-dev_pgdata)
   — or, if you have no data worth keeping, delete the old ones and start clean:

     bun run db:down && docker volume rm ${oldSlug}-dev_pgdata && bun run db:up && bun run db:migrate

2. The existing Postgres role. compose.dev.yml now creates the role and database "${slug}", but a
   volume that already exists was initialised with "${oldSlug}" and POSTGRES_USER is only read on
   first boot. Recreate the volume as above, or keep the old credentials in your .env.

3. The untracked .env files were not touched, and \`bun run setup\` never replaces a value you set.
   In .env: DATABASE_URL (role and database "${oldSlug}"; keep them only for a volume you copied
   across, item 2), EMAIL_FROM's display name, and COMPOSE_PROJECT_NAME (keep "${oldSlug}" while a
   stack with data runs under it, item 1).${aiServiceRow} OTEL_SERVICE_NAME is not an .env row:
   infra/compose.yml, rewritten, names each service ${slug}-api and so on. \`bun run doctor\` warns
   about every row that still names the old product.

4. Lockfiles were not edited. Run \`bun install\` to refresh bun.lock for the new package names and
   commit it, or CI's \`--frozen-lockfile\` will fail. Cargo.lock is refreshed by the next
   \`bun run build:desktop\`.

5. The kit's own coordinates were left verbatim, on purpose. Point the repository URLs at your fork;
   delete anything else here that you do not want in your own README:
${verbatimSites.map((line) => `     ${line}`).join('\n') || '     (none found)'}

6. Existing backup artefacts keep the old "${oldSlug}_" prefix while the tool now writes "${slug}_",
   so \`bun run --cwd infra/backup list\` will not see them. Rename the files, or restore what
   you need before renaming.

7. Your domain, once you have one (QUICKSTART.md, Step 3 and Step 4):
   - .env: DOMAIN (or WEB_URL and API_URL for one origin), SITE_URL and DOCS_URL when they are not
     what DOMAIN derives, TRUSTED_ORIGINS (add the marketing site and the docs), COOKIE_DOMAIN (a
     bare .yourdomain covering app. and api.), EMAIL_FROM on a domain you verified, CONTACT_EMAIL.
   - apps/site/.env and apps/docs/.env: SITE_URL and the PUBLIC_* origins.
   - apps/web/wrangler.jsonc: PUBLIC_API_URL, and the worker names in apps/*/wrangler.jsonc, if you
     deploy to Cloudflare.
   - GitHub: the repository variables the Deploy workflow reads (SITE_URL, DOCS_URL, WEB_URL,
     API_URL, DEPLOY_HOST); IMAGE_REGISTRY follows the repository by itself.
   - DNS: DOMAIN, app., api. and docs. pointing at the server.

8. Desktop: replace the icons in apps/native/src-tauri/icons/, and note that changing the bundle
   identifier changes the OS application-data directory — an already-installed build will not see
   its old local state, and app stores treat it as a different application.

9. What a deploy publishes is the kit's until you replace it:
   - apps/site: the copy on every page and the OG images. The changelog and the blog hold one
     draft sample each, which a build leaves out: write your own entries. The legal pages are
     templates, and a production build refuses them until every **[placeholder]** is filled and
     the template note is gone.
   - apps/docs: your documentation is src/content/product, a two-page start. The kit's manual,
     src/content/docs, is never built unless DOCS_CONTENT=kit; read it with \`bun run dev:manual\`.
   - README.md (the kit's), the description in package.json and in
     apps/web/static/manifest.webmanifest, SECURITY.md (the kit's policy and the seller's address:
     keep it to report kit issues, add your own), .github/ISSUE_TEMPLATE/config.yml (links into
     the kit's repository).

10. Versions. \`version\` in the root package.json is your product's (the kit ships 0.1.0), and
    the API, the OpenAPI document, the site and the desktop builds report it. \`kitVersion\` is the
    kit release you are on. Never edit it: only kit releases change it.

Then: bun install && bun run lint:fix && bun run verify
`);

if (!args.write) {
	console.log('Dry run. Re-run with --write to apply.\n');
}
